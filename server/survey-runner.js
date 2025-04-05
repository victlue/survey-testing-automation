import dotenv from 'dotenv';
import path from 'path';
import { Stagehand } from '@browserbasehq/stagehand';
import fs from 'fs';

// Initialize config
dotenv.config();

// Read the config file passed as argument
const configFile = process.argv[2];
if (!configFile) {
  console.error('Config file not specified');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const { surveyUrl, customQuestions, headless = false, runId = 0 } = config;

async function completeSurvey() {
  // Initialize Stagehand

  console.log(`Mode: ${headless ? 'Headless' : 'Headed'}`);
  if (runId) {
    console.log(`Run ID: ${runId}`);
  }
  const useBrowserbase = process.env.USE_BROWSERBASE === 'true';
  console.log(`Environment: ${useBrowserbase ? 'BROWSERBASE' : 'LOCAL'}`);
  
  const stagehand = new Stagehand({
    env: useBrowserbase ? "BROWSERBASE" : "LOCAL",
    modelName: "claude-3-7-sonnet-latest", // or another supported Anthropic model
    modelClientOptions: {
      apiKey: process.env.ANTHROPIC_API_KEY, // Your Anthropic API key
    },
    localBrowserLaunchOptions: {
      headless: headless // Use the headless parameter from config
    },
    browserbaseOptions: useBrowserbase ? {
      apiKey: process.env.BROWSERBASE_API_KEY, // Browserbase API key
    } : undefined
  });
  
  await stagehand.init();
  const page = stagehand.page;
  
  // Navigate to the survey URL
  console.log(`Navigating to survey URL: ${surveyUrl}`);
  await page.goto(surveyUrl);
  
  // Main survey loop - continue until URL changes away from the survey domain or safety limit reached
  let isComplete = false;
  let pageCount = 0;
  const surveyDomain = new URL(surveyUrl).hostname;
  
  while (!isComplete && pageCount < 50) { // Safety limit of 50 pages
    pageCount++;
    console.log(`Processing page ${pageCount}...`);
    
    // Wait for page to load
    await page.waitForLoadState('networkidle');
    
    // Check if we're still on the survey domain
    const currentUrl = page.url();
    console.log(`Current URL: ${currentUrl}`);
    
    if (!currentUrl.includes(surveyDomain)) {
      console.log("URL changed away from survey domain - survey complete or user disqualified");
      isComplete = true;
      continue;
    }
    
    // Get page content using direct selectors
    const pageInfo = await extractPageInfo(page);
    console.log(`Current page title: ${pageInfo.headingText}`);
    
    // Check for errors
    const errorInfo = await checkForErrors(page);
    
    if (errorInfo.hasError) {
      //console.log(`Error detected: ${errorInfo.errorMessage}. Attempting to fix.`);
      console.log("Error detected. Attempting to fix.");
      await handleError(page, errorInfo, stagehand);
      
      continue;
    } else {
      // Find a matching custom question handler from the configuration
// Find a matching custom question handler from the configuration
      let customHandler = null;

      for (const customQuestion of customQuestions) {
        // Check if question name is visible in the heading
        const nameInHeading = customQuestion.questionName && 
                              pageInfo.headingText.includes(customQuestion.questionName);
        
        // Check if question name or identifier is visible on the page
        const nameVisible = customQuestion.questionName && 
                          await isTextVisibleOnPage(page, customQuestion.questionName);
        
        const identifierVisible = customQuestion.identifier && 
                                await isTextVisibleOnPage(page, customQuestion.identifier);
        
        if (nameInHeading || nameVisible || identifierVisible) {
          customHandler = customQuestion;
          break;
        }
      }

      if (customHandler) {
        console.log(`Found custom handler for question: ${customHandler.questionName}`);
        await handleCustomQuestion(page, customHandler);
      } else {
        // Handle any other question type by selecting a random option
        await handleGenericQuestionPage(page);
      }
    }
    
    // Check if there's a Next button and click it
    try {
      await page.waitForSelector('button:has-text("Next"), input:has-text("Next"), button.next-button', { timeout: 5000 });
      await page.click('button:has-text("Next"), input:has-text("Next"), button.next-button');
      console.log("Clicked Next button");
    } catch (error) {
      console.log("No Next button found, checking if there's a different navigation element");
      
      // Try to find any other navigation button (Submit, Finish, etc.)
      try {
        await page.waitForSelector('button:has-text("Submit"), input:has-text("Submit"), button:has-text("Finish"), input:has-text("Finish")', { timeout: 3000 });
        await page.click('button:has-text("Submit"), input:has-text("Submit"), button:has-text("Finish"), input:has-text("Finish")');
        console.log("Clicked Submit/Finish button");
      } catch (navError) {
        console.log("No navigation buttons found. Survey may be complete or stuck.");
        isComplete = true;
        break;
      }
    }
    
    // Wait a moment for any redirects to occur
    await page.waitForTimeout(2000);
    
    // Check for error messages after navigation
    const afterNavErrorInfo = await checkForErrors(page);
    if (afterNavErrorInfo.hasError) {
      //console.log(`Error after navigation: ${afterNavErrorInfo.errorMessage}. Decrementing page count to retry.`);
      console.log(`Error after navigation. Decrementing page count to retry.`);
      pageCount--;
    }
  }
  
  console.log(`Survey processing complete. Processed ${pageCount} pages.`);
  // Close the browser when done
  await stagehand.close();
}

// Helper function to check if an element is visible
async function isElementVisible(page, selector) {
  try {
    const isVisible = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && 
             style.visibility !== 'hidden' && 
             el.offsetParent !== null &&
             style.opacity !== '0';
    }, selector);
    
    return isVisible;
  } catch (error) {
    console.log(`Error checking visibility for ${selector}:`, error.message);
    return false;
  }
}

// Helper function to get only visible text from elements
async function getVisibleTextFromElements(page, selector) {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel))
      .filter(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && 
               style.visibility !== 'hidden' && 
               el.offsetParent !== null &&
               style.opacity !== '0';
      })
      .map(el => el.textContent.trim());
  }, selector);
}

// Helper to check if text appears in visible elements
async function isTextVisibleOnPage(page, text) {
  return page.evaluate((searchText) => {
    // Get all text-containing elements
    const elements = Array.from(document.querySelectorAll('body *'));
    
    // Filter for visible elements containing the text
    const visibleElements = elements.filter(el => {
      // Skip elements with no text
      if (!el.textContent || !el.textContent.includes(searchText)) return false;
      
      // Check if element is visible
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && 
             style.visibility !== 'hidden' && 
             el.offsetParent !== null &&
             style.opacity !== '0';
    });
    
    return visibleElements.length > 0;
  }, text);
}

// Handle custom questions based on configuration
async function handleCustomQuestion(page, questionConfig) {
  console.log(`Handling custom question: ${questionConfig.questionName}`);
  
  try {
    // Determine question type by checking only VISIBLE page elements
    const hasRadioButtons = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input[type="radio"]'))
        .some(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && 
                 style.visibility !== 'hidden' && 
                 el.offsetParent !== null;
        });
    });
    
    const hasCheckboxes = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input[type="checkbox"]'))
        .some(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && 
                 style.visibility !== 'hidden' && 
                 el.offsetParent !== null;
        });
    });
    
    const hasTextInputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input[type="text"], textarea'))
        .some(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && 
                 style.visibility !== 'hidden' && 
                 el.offsetParent !== null;
        });
    });
    
    const hasDropdowns = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('select'))
        .some(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && 
                 style.visibility !== 'hidden' && 
                 el.offsetParent !== null;
        });
    });
    
    // Rest of your function remains the same
    if (hasRadioButtons) {
      await handleCustomRadioQuestion(page, questionConfig);
    } else if (hasCheckboxes) {
      await handleCustomCheckboxQuestion(page, questionConfig);
    } else if (hasDropdowns) {
      await handleCustomDropdownQuestion(page, questionConfig);
    } else if (hasTextInputs) {
      await handleCustomTextQuestion(page, questionConfig);
    } else {
      console.log("No recognized input elements found for custom question. Using generic handler.");
      await handleGenericQuestionPage(page);
    }
  } catch (error) {
    console.log(`Error handling custom question: ${error}`);
    await handleGenericQuestionPage(page);
  }
}

// Handle custom radio button questions
// Handle custom radio button questions
async function handleCustomRadioQuestion(page, questionConfig) {
  console.log("Handling custom radio question");
  
  try {
    // Get all radio options on the page
    const radioOptions = await page.$$eval('input[type="radio"]', radios => {
      return radios.map(radio => {
        // Try to get the label text
        let labelText = '';
        
        // Check for associated label
        if (radio.id) {
          const label = document.querySelector(`label[for="${radio.id}"]`);
          if (label) labelText = label.textContent.trim();
        }
        
        // Check for parent label
        if (!labelText && radio.closest('label')) {
          labelText = radio.closest('label').textContent.trim();
        }
        
        // Last resort: get parent element text
        if (!labelText && radio.parentElement) {
          labelText = radio.parentElement.textContent.trim();
        }
        
        return {
          id: radio.id,
          value: radio.value,
          name: radio.name,
          labelText: labelText
        };
      });
    });
    
    console.log(`Found ${radioOptions.length} radio options`);
    
    // Map configuration options to radio buttons on page
    const optionsWithProbabilities = [];
    
    for (const configOption of questionConfig.options) {
      // Find matching radio button for this config option
      const matchingRadios = radioOptions.filter(radio => 
        radio.labelText.includes(configOption.text)
      );
      
      if (matchingRadios.length > 0) {
        // Use the first matching radio button
        optionsWithProbabilities.push({
          radio: matchingRadios[0],
          probability: configOption.probability
        });
      }
    }
    
    if (optionsWithProbabilities.length === 0) {
      console.log("No matching radio buttons found for the configured options");
      await handleGenericQuestionPage(page);
      return;
    }
    
    // Select an option based on the configured probabilities
    const randomValue = Math.random() * 100;
    let cumulativeProbability = 0;
    let selectedOption = null;
    
    for (const option of optionsWithProbabilities) {
      cumulativeProbability += option.probability;
      if (randomValue < cumulativeProbability) {
        selectedOption = option.radio;
        break;
      }
    }
    
    // If no option was selected (due to probability rounding errors), use the last one
    if (!selectedOption && optionsWithProbabilities.length > 0) {
      selectedOption = optionsWithProbabilities[optionsWithProbabilities.length - 1].radio;
    }
    
    if (selectedOption) {
      console.log(`Selecting option: ${selectedOption.labelText}`);
      
      // Try multiple selection strategies for more reliability
      let selectionSuccessful = false;
      
      // Strategy 1: Try text-based selection (prioritized)
      console.log(`Attempting to click by text: "${selectedOption.labelText}"`);
      try {
        await page.click(`text="${selectedOption.labelText}"`);
        selectionSuccessful = true;
        console.log("Selection by text successful");
      } catch (error) {
        console.log(`Error selecting by text: ${error.message}`);
        
        // Try partial text match
        try {
          const firstWords = selectedOption.labelText.split(' ').slice(0, 2).join(' ');
          console.log(`Attempting to click by partial text: "${firstWords}"`);
          await page.click(`text="${firstWords}"`);
          selectionSuccessful = true;
          console.log("Selection by partial text successful");
        } catch (partialError) {
          console.log(`Error selecting by partial text: ${partialError.message}`);
        }
      }
      
      // Strategy 2: Try clicking by ID if available
      if (!selectionSuccessful && selectedOption.id) {
        console.log(`Attempting to click by ID: input[id="${selectedOption.id}"]`);
        try {
          await page.click(`input[id="${selectedOption.id}"]`);
          selectionSuccessful = true;
          console.log("Selection by ID successful");
        } catch (error) {
          console.log(`Error selecting by ID: ${error.message}`);
        }
      }
      
      // Strategy 3: Try clicking by name and value
      if (!selectionSuccessful && selectedOption.name && selectedOption.value) {
        console.log(`Attempting to click by name and value: input[name="${selectedOption.name}"][value="${selectedOption.value}"]`);
        try {
          await page.click(`input[name="${selectedOption.name}"][value="${selectedOption.value}"]`);
          selectionSuccessful = true;
          console.log("Selection by name and value successful");
        } catch (error) {
          console.log(`Error selecting by name and value: ${error.message}`);
        }
      }
      
      // Strategy 4: Use evaluate to click directly in the DOM
      if (!selectionSuccessful) {
        console.log("Attempting to click using DOM evaluation");
        try {
          await page.evaluate((labelText) => {
            // Try to find by checking all radio buttons
            const allRadios = Array.from(document.querySelectorAll('input[type="radio"]'));
            for (const radio of allRadios) {
              // Check if label contains the text
              let label = radio.id ? document.querySelector(`label[for="${radio.id}"]`) : null;
              if (!label) label = radio.closest('label');
              
              if (label && label.textContent.includes(labelText)) {
                radio.click();
                return true;
              }
            }
            return false;
          }, selectedOption.labelText);
          
          selectionSuccessful = true;
          console.log("Selection using DOM evaluation successful");
        } catch (error) {
          console.log(`Error with DOM evaluation selection: ${error.message}`);
        }
      }
      
      // Final strategy: Use natural language
      if (!selectionSuccessful) {
        console.log("Attempting to select using natural language");
        try {
          await page.act(`Select the option "${selectedOption.labelText}" for this question`);
          selectionSuccessful = true;
          console.log("Selection using natural language successful");
        } catch (error) {
          console.log(`Error with natural language selection: ${error.message}`);
        }
      }
      
      if (!selectionSuccessful) {
        console.log("All selection strategies failed. Using generic handler.");
        await handleGenericQuestionPage(page);
      }
    } else {
      console.log("Failed to select a radio option. Using generic handler.");
      await handleGenericQuestionPage(page);
    }
  } catch (error) {
    console.log(`Error in custom radio handler: ${error}`);
    await handleGenericQuestionPage(page);
  }
}

// Handle custom checkbox questions
async function handleCustomCheckboxQuestion(page, questionConfig) {
  console.log("Handling custom checkbox question");
  
  try {
    // Get all checkbox options on the page
    const checkboxOptions = await page.$$eval('input[type="checkbox"]', checkboxes => {
      return checkboxes.map(checkbox => {
        // Try to get the label text
        let labelText = '';
        
        // Check for associated label
        if (checkbox.id) {
          const label = document.querySelector(`label[for="${checkbox.id}"]`);
          if (label) labelText = label.textContent.trim();
        }
        
        // Check for parent label
        if (!labelText && checkbox.closest('label')) {
          labelText = checkbox.closest('label').textContent.trim();
        }
        
        // Last resort: get parent element text
        if (!labelText && checkbox.parentElement) {
          labelText = checkbox.parentElement.textContent.trim();
        }
        
        return {
          id: checkbox.id,
          value: checkbox.value,
          name: checkbox.name,
          labelText: labelText
        };
      });
    });
    
    console.log(`Found ${checkboxOptions.length} checkbox options`);
    
    // DEBUG: Log all found checkbox labels to see what text we're working with
    console.log("Available checkbox labels:");
    checkboxOptions.forEach((opt, i) => {
      console.log(`  [${i}] ${opt.labelText.substring(0, 40)}${opt.labelText.length > 40 ? '...' : ''}`);
    });
    
    // Map configuration options to checkboxes on page
    const optionsWithProbabilities = [];
    
    for (const configOption of questionConfig.options) {
      // Find matching checkbox for this config option (using includes for more flexible matching)
      const matchingCheckboxes = checkboxOptions.filter(checkbox => 
        checkbox.labelText.toLowerCase().includes(configOption.text.toLowerCase())
      );
      
      if (matchingCheckboxes.length > 0) {
        // Log what we're matching
        console.log(`Found ${matchingCheckboxes.length} checkboxes matching "${configOption.text}" with probability ${configOption.probability}%`);
        
        // Use the first matching checkbox
        optionsWithProbabilities.push({
          checkbox: matchingCheckboxes[0],
          probability: configOption.probability
        });
      } else {
        console.log(`No matching checkbox found for option: "${configOption.text}"`);
      }
    }
    
    if (optionsWithProbabilities.length === 0) {
      console.log("No matching checkboxes found for any configured options");
      console.log("Falling back to generic question handler");
      await handleGenericQuestionPage(page);
      return;
    }
    
    // Count how many options we've selected
    let selectedCount = 0;
    
    // For each option, decide whether to select it based on its probability
    for (const option of optionsWithProbabilities) {
      const randomValue = Math.random() * 100;
      console.log(`Checking option: "${option.checkbox.labelText.substring(0, 30)}..." (${option.probability}% chance vs ${randomValue.toFixed(2)})`);
      
      if (randomValue < option.probability) {
        console.log(`Selecting checkbox: "${option.checkbox.labelText.substring(0, 30)}..."`);
        
        // Try multiple selection strategies for more reliability
        let selectionSuccessful = false;
        
        // Strategy 1: Try text-based selection (prioritized)
        try {
          console.log(`Attempting to check by text`);
          await page.check(`text="${option.checkbox.labelText}"`);
          selectionSuccessful = true;
          selectedCount++;
          console.log("Selection by text successful");
        } catch (error) {
          console.log(`Error selecting by text: ${error.message}`);
          
          // Try partial text match
          try {
            const firstWords = option.checkbox.labelText.split(' ').slice(0, 2).join(' ');
            console.log(`Attempting to check by partial text: "${firstWords}"`);
            await page.check(`text="${firstWords}"`);
            selectionSuccessful = true;
            selectedCount++;
            console.log("Selection by partial text successful");
          } catch (partialError) {
            console.log(`Error selecting by partial text: ${partialError.message}`);
          }
        }
        
        // Strategy 2: Try checking by ID if available
        if (!selectionSuccessful && option.checkbox.id) {
          console.log(`Attempting to check by ID: input[id="${option.checkbox.id}"]`);
          try {
            await page.check(`input[id="${option.checkbox.id}"]`);
            selectionSuccessful = true;
            selectedCount++;
            console.log("Selection by ID successful");
          } catch (error) {
            console.log(`Error selecting by ID: ${error.message}`);
          }
        }
        
        // Strategy 3: Try checking by name and value
        if (!selectionSuccessful && option.checkbox.name && option.checkbox.value) {
          console.log(`Attempting to check by name and value`);
          try {
            await page.check(`input[name="${option.checkbox.name}"][value="${option.checkbox.value}"]`);
            selectionSuccessful = true;
            selectedCount++;
            console.log("Selection by name and value successful");
          } catch (error) {
            console.log(`Error selecting by name and value: ${error.message}`);
          }
        }
        
        // Strategy 4: Use evaluate to check directly in the DOM
        if (!selectionSuccessful) {
          console.log("Attempting to check using DOM evaluation");
          try {
            await page.evaluate((selOpt) => {
              // Try to find by checking all checkboxes
              const allCheckboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
              for (const checkbox of allCheckboxes) {
                // Check if label contains the text
                let label = checkbox.id ? document.querySelector(`label[for="${checkbox.id}"]`) : null;
                if (!label) label = checkbox.closest('label');
                
                if (label && label.textContent.includes(selOpt.labelText)) {
                  if (!checkbox.checked) {
                    checkbox.click();
                  }
                  return true;
                }
              }
              return false;
            }, option.checkbox);
            
            selectionSuccessful = true;
            selectedCount++;
            console.log("Selection using DOM evaluation successful");
          } catch (error) {
            console.log(`Error with DOM evaluation selection: ${error.message}`);
          }
        }
        
        // Final strategy: Use natural language
        if (!selectionSuccessful) {
          console.log("Attempting to select using natural language");
          try {
            await page.act(`Check the checkbox option "${option.checkbox.labelText}"`);
            selectionSuccessful = true;
            selectedCount++;
            console.log("Selection using natural language successful");
          } catch (error) {
            console.log(`Error with natural language selection: ${error.message}`);
          }
        }
        
        if (!selectionSuccessful) {
          console.log(`Failed to select checkbox option: ${option.checkbox.labelText}`);
        }
      }
    }
    
    // If no options were selected and this is a required question, select at least one
    if (selectedCount === 0) {
      console.log("WARNING: No checkboxes were selected based on probabilities.");
      console.log("Selecting the highest probability option since all questions are required.");
      
      // Find the option with the highest probability
      let highestProbOption = optionsWithProbabilities.reduce((prev, current) => 
        (prev.probability > current.probability) ? prev : current
      );
      
      if (highestProbOption) {
        console.log(`Selecting highest probability option: "${highestProbOption.checkbox.labelText}" (${highestProbOption.probability}%)`);
        
        // Try all selection strategies for the highest probability option
        let selectionSuccessful = false;
        
        // Try by text first (prioritized)
        try {
          await page.check(`text="${highestProbOption.checkbox.labelText}"`);
          selectionSuccessful = true;
          console.log("Successfully selected highest probability option by text");
        } catch (error) {
          console.log("Error selecting by text:", error.message);
          
          // Try partial text match if full text fails
          try {
            const firstWords = highestProbOption.checkbox.labelText.split(' ').slice(0, 2).join(' ');
            console.log(`Attempting to check by partial text: "${firstWords}"`);
            await page.check(`text="${firstWords}"`);
            selectionSuccessful = true;
            console.log("Successfully selected highest probability option by partial text");
          } catch (partialError) {
            console.log("Error selecting by partial text:", partialError.message);
          }
        }
        
        // If text-based selection failed, try by ID
        if (!selectionSuccessful && highestProbOption.checkbox.id) {
          try {
            await page.check(`input[id="${highestProbOption.checkbox.id}"]`);
            selectionSuccessful = true;
            console.log("Successfully selected highest probability option by ID");
          } catch (error) {
            console.log("Error selecting by ID:", error.message);
          }
        }
        
        // If ID failed, try by name and value
        if (!selectionSuccessful && highestProbOption.checkbox.name && highestProbOption.checkbox.value) {
          try {
            await page.check(`input[name="${highestProbOption.checkbox.name}"][value="${highestProbOption.checkbox.value}"]`);
            selectionSuccessful = true;
            console.log("Successfully selected highest probability option by name/value");
          } catch (error) {
            console.log("Error selecting by name/value:", error.message);
          }
        }
        
        // Last resort - use natural language
        if (!selectionSuccessful) {
          try {
            await page.act("Select at least one checkbox for this required question");
            console.log("Used natural language to select a checkbox");
          } catch (nlError) {
            console.log("Failed to select using natural language:", nlError);
          }
        }
      }
    }
    
  } catch (error) {
    console.log(`Error in custom checkbox handler: ${error}`);
    await handleGenericQuestionPage(page);
  }
}

// Handle custom text input questions
async function handleCustomTextQuestion(page, questionConfig) {
  console.log("Handling custom text question");
  
  try {
    // Get all text inputs on the page
    const textInputs = await page.$$('input[type="text"], textarea');
    console.log(`Found ${textInputs.length} text input fields`);
    
    if (textInputs.length === 0) {
      console.log("No text inputs found. Using generic handler.");
      await handleGenericQuestionPage(page);
      return;
    }
    
    // For text inputs, we'll use a different approach than radio/checkbox
    // We'll select one text option based on probability
    
    // Calculate total probability to normalize if needed
    const totalProbability = questionConfig.options.reduce((sum, option) => sum + option.probability, 0);
    
    // Select a response based on probability
    const randomValue = Math.random() * totalProbability;
    let cumulativeProbability = 0;
    let selectedResponse = null;
    
    for (const option of questionConfig.options) {
      cumulativeProbability += option.probability;
      if (randomValue < cumulativeProbability) {
        selectedResponse = option.text;
        break;
      }
    }
    
    // Fallback: If no option was selected, use the one with highest probability
    if (!selectedResponse && questionConfig.options.length > 0) {
      const highestProbOption = questionConfig.options.reduce((prev, current) => 
        (prev.probability > current.probability) ? prev : current
      );
      selectedResponse = highestProbOption.text;
    }
    
    if (selectedResponse) {
      console.log(`Selected text response: "${selectedResponse.substring(0, 30)}${selectedResponse.length > 30 ? '...' : ''}"`);
      
      // Find the most relevant text input field (usually the first one for simple questions)
      // For more complex forms, we might need more sophisticated logic
      const inputField = textInputs[0];
      
      try {
        // Clear any existing value first
        await inputField.fill('');
        // Then enter our selected response
        await inputField.fill(selectedResponse);
        console.log("Successfully filled text input");
      } catch (error) {
        console.log(`Error filling text input: ${error.message}`);
        
        // Try fallback method with Playwright's more direct fill method
        try {
          await page.fill('input[type="text"], textarea', selectedResponse);
          console.log("Filled text input using page.fill method");
        } catch (fillError) {
          console.log(`Error with page.fill method: ${fillError.message}`);
          
          // Last resort: Try natural language
          try {
            await page.act(`Enter the text "${selectedResponse}" into the input field`);
            console.log("Filled text input using natural language");
          } catch (nlError) {
            console.log(`Error with natural language: ${nlError.message}`);
          }
        }
      }
    } else {
      console.log("No text response selected. Using generic handler.");
      await handleGenericQuestionPage(page);
    }
  } catch (error) {
    console.log(`Error in custom text handler: ${error}`);
    await handleGenericQuestionPage(page);
  }
}

// Add new function for handling custom dropdown questions
async function handleCustomDropdownQuestion(page, questionConfig) {
  console.log("Handling custom dropdown question");
  
  try {
    // Get all select elements on the page
    const selectElements = await page.$$('select');
    console.log(`Found ${selectElements.length} dropdown/select elements`);
    
    if (selectElements.length === 0) {
      console.log("No dropdown elements found. Using generic handler.");
      await handleGenericQuestionPage(page);
      return;
    }
    
    // For dropdowns, we'll typically use the first select element
    const select = selectElements[0];
    
    // Get all available options in the dropdown
    const dropdownOptions = await select.$$eval('option', options => {
      return options.map(option => ({
        value: option.value,
        text: option.textContent.trim(),
        index: option.index,
        disabled: option.disabled,
        selected: option.selected
      })).filter(opt => opt.value && !opt.disabled); // Filter out placeholder or disabled options
    });
    
    console.log(`Found ${dropdownOptions.length} selectable dropdown options`);
    
    // Log available dropdown options for debugging
    console.log("Available dropdown options:");
    dropdownOptions.forEach((opt, i) => {
      console.log(`  [${i}] Text: "${opt.text.substring(0, 40)}${opt.text.length > 40 ? '...' : ''}"`);
    });
    
    // Map configuration options to dropdown options
    const optionsWithProbabilities = [];
    
    for (const configOption of questionConfig.options) {
      // Find matching dropdown option for this config option (case-insensitive)
      const matchingOptions = dropdownOptions.filter(option => 
        option.text.toLowerCase().includes(configOption.text.toLowerCase())
      );
      
      if (matchingOptions.length > 0) {
        console.log(`Found ${matchingOptions.length} dropdown options matching "${configOption.text}" with probability ${configOption.probability}%`);
        
        // Use the first matching option
        optionsWithProbabilities.push({
          option: matchingOptions[0],
          probability: configOption.probability
        });
      } else {
        console.log(`No matching dropdown option found for: "${configOption.text}"`);
      }
    }
    
    if (optionsWithProbabilities.length === 0) {
      console.log("No matching dropdown options found for any configured options");
      console.log("Using generic dropdown selection");
      
      // Fall back to selecting a random option
      if (dropdownOptions.length > 0) {
        const randomIndex = Math.floor(Math.random() * dropdownOptions.length);
        await select.selectOption({ index: randomIndex });
        console.log(`Selected random dropdown option with index ${randomIndex}`);
      }
      return;
    }
    
    // Select an option based on the configured probabilities
    const randomValue = Math.random() * 100;
    let cumulativeProbability = 0;
    let selectedOption = null;
    
    for (const option of optionsWithProbabilities) {
      cumulativeProbability += option.probability;
      if (randomValue < cumulativeProbability) {
        selectedOption = option.option;
        break;
      }
    }
    
    // If no option was selected (due to probability rounding errors), use the highest probability option
    if (!selectedOption && optionsWithProbabilities.length > 0) {
      // Find the option with the highest probability
      const highestProbOption = optionsWithProbabilities.reduce((prev, current) => 
        (prev.probability > current.probability) ? prev : current
      );
      selectedOption = highestProbOption.option;
    }
    
    if (selectedOption) {
      console.log(`Selecting dropdown option: "${selectedOption.text}"`);
      
      // Try multiple selection strategies for more reliability
      let selectionSuccessful = false;
      
      // Strategy 1: Try selecting by text/label (PRIORITIZED)
      try {
        await select.selectOption({ label: selectedOption.text });
        selectionSuccessful = true;
        console.log("Selection by label/text successful");
      } catch (error) {
        console.log(`Error selecting by label/text: ${error.message}`);
        
        // Try with exact text matching if partial matching fails
        try {
          // Find exact match in dropdown options
          const exactMatch = dropdownOptions.find(opt => opt.text === selectedOption.text);
          if (exactMatch) {
            await select.selectOption({ label: exactMatch.text });
            selectionSuccessful = true;
            console.log("Selection by exact label/text successful");
          }
        } catch (exactError) {
          console.log(`Error selecting by exact label/text: ${exactError.message}`);
        }
      }
      
      // Strategy 2: Try selecting by value
      if (!selectionSuccessful) {
        try {
          await select.selectOption({ value: selectedOption.value });
          selectionSuccessful = true;
          console.log("Selection by value successful");
        } catch (error) {
          console.log(`Error selecting by value: ${error.message}`);
        }
      }
      
      // Strategy 3: Try selecting by index
      if (!selectionSuccessful) {
        try {
          await select.selectOption({ index: selectedOption.index });
          selectionSuccessful = true;
          console.log("Selection by index successful");
        } catch (error) {
          console.log(`Error selecting by index: ${error.message}`);
        }
      }
      
      // Strategy 4: Use evaluate to select directly in the DOM
      if (!selectionSuccessful) {
        console.log("Attempting to select using DOM evaluation");
        try {
          await page.evaluate((selOpt) => {
            const selects = Array.from(document.querySelectorAll('select'));
            if (selects.length === 0) return false;
            
            const select = selects[0];
            const options = Array.from(select.options);
            
            // Try to find option by text content
            for (const option of options) {
              if (option.textContent.includes(selOpt.text)) {
                select.value = option.value;
                // Trigger change event to ensure any listeners know the select has changed
                select.dispatchEvent(new Event('change'));
                return true;
              }
            }
            return false;
          }, selectedOption);
          
          selectionSuccessful = true;
          console.log("Selection using DOM evaluation successful");
        } catch (error) {
          console.log(`Error with DOM evaluation selection: ${error.message}`);
        }
      }
      
      // Final strategy: Use natural language
      if (!selectionSuccessful) {
        console.log("Attempting to select using natural language");
        try {
          await page.act(`Select the option "${selectedOption.text}" from the dropdown menu`);
          selectionSuccessful = true;
          console.log("Selection using natural language successful");
        } catch (error) {
          console.log(`Error with natural language selection: ${error.message}`);
        }
      }
      
      if (!selectionSuccessful) {
        console.log("All selection strategies failed. Using generic handler.");
        await handleGenericQuestionPage(page);
      }
    } else {
      console.log("Failed to select a dropdown option. Using generic handler.");
      await handleGenericQuestionPage(page);
    }
  } catch (error) {
    console.log(`Error in custom dropdown handler: ${error}`);
    await handleGenericQuestionPage(page);
  }
}

// Import your existing functions here
async function extractPageInfo(page) {
  try {
    // Get only visible heading text
    let headingText = '';
    try {
      const visibleHeadings = await getVisibleTextFromElements(page, 'h1, h2, h3, .page-title, .question-title');
      headingText = visibleHeadings.length > 0 ? visibleHeadings[0] : '';
    } catch (error) {
      console.log("Error getting visible heading text:", error);
    }
    
    // Get only visible body text
    const pageContent = await page.evaluate(() => {
      // Get all text nodes that are visible
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function(node) {
            // Skip empty text nodes
            if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
            
            // Check if parent element is visible
            const el = node.parentElement;
            if (!el) return NodeFilter.FILTER_REJECT;
            
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || 
                style.visibility === 'hidden' || 
                el.offsetParent === null ||
                style.opacity === '0') {
              return NodeFilter.FILTER_REJECT;
            }
            
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      
      // Collect visible text
      let text = '';
      let node;
      while (node = walker.nextNode()) {
        text += ' ' + node.textContent.trim();
      }
      
      return text.trim();
    });
    
    return {
      headingText,
      pageContent
    };
  } catch (error) {
    console.log("Error extracting page info:", error);
    return {
      headingText: '',
      pageContent: ''
    };
  }
}

async function checkForErrors(page) {
  const errorInfo = {
    hasError: false,
    errorMessage: '',
    inputType: null,
    resolved: false
  };
  
  try {
    // First check for common error message phrases on visible text

    const currentUrl = page.url().toLowerCase();
    const isQualtricsSurvey = currentUrl.includes('qualtrics');
    const isAlchemerSurvey = currentUrl.includes('alchemer');
    
    console.log(`Survey platform: ${isQualtricsSurvey ? 'Qualtrics' : (isAlchemerSurvey ? 'Alchemer' : 'Unknown')}`);
    
    console.log("Checking for page-level errors...");
    const hasPageLevelError = await page.evaluate(() => {
      // Get all text nodes that are visible
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function(node) {
            // Skip empty text nodes
            if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
            
            // Check if parent element is visible
            const el = node.parentElement;
            if (!el) return NodeFilter.FILTER_REJECT;
            
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || 
                style.visibility === 'hidden' || 
                el.offsetParent === null ||
                style.opacity === '0') {
              return NodeFilter.FILTER_REJECT;
            }
            
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      
      // Check each visible text node for error phrases
      let foundError = false;
      let node;
      while (node = walker.nextNode()) {
        const text = node.textContent.toLowerCase();
        if (text.includes('there was an error on your page') || 
            text.includes('submit again') ||
            text.includes('please correct')) {
          console.log("Error found at this following node:")
          console.log(text)
          foundError = true;
          break;
        }
      }
      
      return foundError;
    });
    
    // NEW: Check for red text elements (common in Qualtrics error messages)
    let hasRedTextError = false;
    if (isQualtricsSurvey) {
     hasRedTextError = await page.evaluate(() => {
      // Get all visible elements
      const allElements = Array.from(document.querySelectorAll('*')).filter(el => {
        if (!el.textContent.trim()) return false;
        
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && 
               style.visibility !== 'hidden' && 
               el.offsetParent !== null &&
               style.opacity !== '0';
      });
      
      // Find elements with red text (various ways red might be specified)
      const redElements = allElements.filter(el => {
        const style = window.getComputedStyle(el);
        const color = style.color.toLowerCase();
        
        // Check for various forms of red
        return (
          // RGB format
          color.includes('rgb(255, 0, 0)') || 
          color.includes('rgb(255,0,0)') ||
          // Common red shades in RGB
          (color.includes('rgb(') && 
           parseInt(color.split('(')[1].split(',')[0].trim()) > 200 && 
           parseInt(color.split(',')[1].trim()) < 100 && 
           parseInt(color.split(',')[2].split(')')[0].trim()) < 100) ||
          // Hex format red shades
          color === '#ff0000' || 
          color === '#f00' || 
          color.startsWith('#f') || 
          // Named colors
          color === 'red' || 
          color === 'crimson' || 
          color === 'firebrick' || 
          color === 'darkred' || 
          color === 'indianred' ||
          // Look for error classes
          el.className.includes('error') ||
          el.className.includes('invalid') ||
          el.className.includes('validation') ||
          // Also check for error icons/symbols (like ❌ ⚠️ or exclamation marks)
          el.textContent.includes('⚠️') ||
          el.textContent.includes('❌') ||
          el.textContent.includes('!')
        );
      });
      
      return redElements.length > 0;
    });
  }
    
    if (hasRedTextError){
      console.log("hasRedTextError")
    }
    if (hasPageLevelError || hasRedTextError) {
      console.log("Error detected on page");
      errorInfo.hasError = true;
      
      // Get all potential error messages (both standard errors and red text)
      console.log("Collecting error details...");
      const errorMessages = await page.evaluate(() => {
        // Find elements that might contain error messages and are visible
        const errorElements = Array.from(document.querySelectorAll('*')).filter(el => {
          const style = window.getComputedStyle(el);
          const text = el.textContent.trim();
          const isVisible = style.display !== 'none' && 
                          style.visibility !== 'hidden' && 
                          el.offsetParent !== null &&
                          style.opacity !== '0';
          
          if (!isVisible || !text) return false;
          
          // Check for error indicators (text content and color)
          const isErrorText = text.toLowerCase().includes('error') || 
                             text.toLowerCase().includes('required') || 
                             text.toLowerCase().includes('characters') ||
                             text.toLowerCase().includes('minimum') ||
                             text.toLowerCase().includes('please') ||
                             text.toLowerCase().includes('must') ||
                             text.toLowerCase().includes('invalid');
          
          // Check for red text
          const color = style.color.toLowerCase();
          const isRedText = (
            color.includes('rgb(255, 0, 0)') || 
            color.includes('rgb(255,0,0)') ||
            (color.includes('rgb(') && 
             parseInt(color.split('(')[1].split(',')[0].trim()) > 200 && 
             parseInt(color.split(',')[1].trim()) < 100 && 
             parseInt(color.split(',')[2].split(')')[0].trim()) < 100) ||
            color === '#ff0000' || 
            color === '#f00' || 
            color.startsWith('#f') || 
            color === 'red' || 
            color === 'crimson' || 
            color === 'firebrick' || 
            color === 'darkred' || 
            color === 'indianred'
          );
          
          // Check for error classes
          const hasErrorClass = el.className.includes('error') ||
                               el.className.includes('invalid') ||
                               el.className.includes('validation');
                               
          return isVisible && (isErrorText || isRedText || hasErrorClass);
        });
        
        return errorElements.map(el => el.textContent.trim());
      });
      
      // Store error message
      errorInfo.errorMessage = errorMessages.join(' | ');
      
      // Try to determine if this is a numeric input error
      if (errorInfo.errorMessage.toLowerCase().includes('number') ||
          errorInfo.errorMessage.toLowerCase().includes('numeric') ||
          errorInfo.errorMessage.toLowerCase().includes('digit')) {
        errorInfo.inputType = "number";
      }
    } else {
      console.log("No errors detected on page");
    }
  } catch (error) {
    console.log("Error in checkForErrors function");
    console.error(error);
  }
  
  return errorInfo;
}

async function handleError(page, errorInfo, stagehandInstance) {
  console.log("Handling detected error...");
  
  if (!errorInfo.hasError) {
    console.log("No error to handle");
    return;
  }
  
  // First attempt: Try simple fix with natural language
  try {
    console.log("Attempting simple fix with natural language...");
    await page.act("Please fix the error on this page");
    
    // Wait a moment for changes to apply
    await page.waitForTimeout(1000);
    
    // Try to navigate to the next page
    console.log("Attempting to navigate to next page after simple fix...");
    await clickNextButton(page);
    
    // Wait for navigation to complete
    await page.waitForTimeout(2000);
    
    // Check if we've moved to a new page or still have an error
    const errorAfterSimpleFix = await checkForErrors(page);
    
    if (!errorAfterSimpleFix.hasError) {
      console.log("Error resolved with simple natural language fix!");
      return;
    }
    
    console.log("Simple fix didn't resolve the error, trying advanced analysis...");
  } catch (simpleFixError) {
    console.log("Error during simple fix attempt:", simpleFixError);
  }
  
  // Second attempt: Use screenshot analysis to get precise error details
  try {
    console.log("Taking error screenshot for analysis...");
    const screenshotPath = path.join('screenshots', `error-${Date.now()}.png`);
    console.log(screenshotPath)
    await page.screenshot({ path: screenshotPath });
    console.log(`Screenshot saved to ${screenshotPath}`);
    
    // Import file system module
    const { readFile } = await import('fs/promises');
    
    // Read the screenshot file
    const imageBuffer = await readFile(screenshotPath);
    const base64Image = imageBuffer.toString('base64');
    
    // Get the same API key that Stagehand is using
    const AnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    console.log("Sending request to Anthropic API for error analysis...");
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': AnthropicApiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: "claude-3-7-sonnet-latest",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "What was wrong with our answer input according to the error message in this screenshot? Please identify the specific error and what needs to be fixed. Answer very concisely."
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: base64Image
                }
              }
            ]
          }
        ]
      })
    });
    
    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}`);
    }
    
    // Extract the analysis from the response
    const responseData = await response.json();
    const errorAnalysis = responseData.content[0].text;
    console.log(`Error analysis: ${errorAnalysis}`);
    
    // Third attempt: Use specific natural language command with the error analysis
    console.log("Attempting fix with specific error analysis...");
    await page.act(`Fix this error: ${errorAnalysis}`);
    
    // Wait a moment for changes to apply
    await page.waitForTimeout(1000);
    
    // Try to navigate to the next page
    console.log("Attempting to navigate to next page after detailed fix...");
    await clickNextButton(page);
    
    // Wait for navigation to complete
    await page.waitForTimeout(2000);
    
    // Check if we've moved to a new page or still have an error
    const errorAfterDetailedFix = await checkForErrors(page);
    
    if (!errorAfterDetailedFix.hasError) {
      console.log("Error resolved with detailed analysis fix!");
      return;
    }
    
    console.log("Detailed fix didn't resolve the error, will try Computer Use model...");
    
    // NEW SECTION: Fourth attempt - Use OpenAI's Computer Use model
    try {
      console.log("Creating Computer Use agent as fallback...");
      
      // Create a Computer Use agent
      const computerUseAgent = stagehandInstance.agent({
        provider: "anthropic",
        model: "claude-3-7-sonnet-20250219",
        options: {
          apiKey: process.env.ANTHROPIC_API_KEY,
        }
      });
      
      // First give the agent the error context
      const promptWithContext = `Fix this error on the survey page: ${errorAnalysis}. Then make sure to click the Next button when fixed`;
      console.log("Instruction given to computer use agent:")
      console.log(promptWithContext)
      console.log("Executing Computer Use agent with error context...");
      await computerUseAgent.execute(promptWithContext);
      
      // Wait for agent actions to complete
      await page.waitForTimeout(8000);
      
      // Check if the error is resolved
      const errorAfterComputerUse = await checkForErrors(page);
      if (!errorAfterComputerUse.hasError) {
        console.log("Error successfully resolved with Computer Use agent!");
        return;
      }
      
      console.log("Computer Use agent couldn't fix the error, trying last resort...");
    } catch (computerUseError) {
      console.log("Error using Computer Use agent:", computerUseError);
    }
    
  } catch (advancedFixError) {
    console.log("Error during advanced fix attempt:");
    console.error(advancedFixError);
  }
  
  // Last resort: fall back to a generic fix with more context
  console.log("Falling back to generic fix...");
  await page.act("There seems to be an error with the input. Please fix any validation issues and proceed.");
  
  // Wait a moment
  await page.waitForTimeout(1000);
  
  // Try to navigate to the next page
  console.log("Attempting to navigate to next page after generic fix...");
  await clickNextButton(page);

  await page.waitForTimeout(2000);
  const finalErrorCheck = await checkForErrors(page);
  
  if (finalErrorCheck.hasError) {
    console.log("===============================================");
    console.log("ERROR: Unable to resolve error after all attempts.");
    console.log("Error persists despite trying simple natural language,");
    console.log("detailed analysis, computer use agent, and generic fix.");
    console.log(`Final error message: ${finalErrorCheck.errorMessage}`);
    console.log("Ending survey automation...");
    console.log("===============================================");
    
    // Close the browser and terminate the process
    await stagehandInstance.close();
    process.exit(1); // Exit with error code
  }
}

// Helper function for clicking the next button
async function clickNextButton(page) {
  try {
    // Look for Next, Submit, or Finish buttons
    const nextButtonSelector = 'button:has-text("Next"), input:has-text("Next"), button.next-button, button:has-text("Submit"), input:has-text("Submit"), button:has-text("Finish"), input:has-text("Finish")';
    
    await page.waitForSelector(nextButtonSelector, { timeout: 5000 });
    await page.click(nextButtonSelector);
    console.log("Clicked navigation button");
    return true;
  } catch (error) {
    console.log("No navigation buttons found:", error.message);
    return false;
  }
}

async function handleVoterFilePage(page) {
  // Your existing implementation
  console.log("Handling Voter File Match page...");
  try {
    await page.fill('text="First Name" >> xpath=../following::input[1]', 'Victor');
    await page.fill('text="Last Name" >> xpath=../following::input[1]', 'Lue');
    await page.fill('text="Zip Code as listed on your voter registration" >> xpath=../following::input[1]', '10583');
  } catch (error) {
    // Fallback to natural language if direct selectors fail
    console.log("Direct commands failed, trying natural language...");
    await page.act('Fill in the first name field with "Victor"');
    await page.act('Fill in the last name field with "Lue"');
    await page.act('Fill in the zip code field with "10583"');
  }
}

async function handleGenericQuestionPage(page, errorInfo = null) {
  // Your existing implementation
  console.log("Handling generic question page...");
  
  try {
    // Get page content for question type analysis
    const pageContent = await page.$$eval('body', elements => elements[0].textContent.trim());
    
    // First check if this is a matrix/grid question
    const isMatrixQuestion = await page.evaluate(() => {
      // Check for common matrix question patterns
      const hasTableRows = document.querySelectorAll('tr, .matrix-row, .survey-row').length > 1;
      const hasColumnHeaders = document.querySelectorAll('th, .matrix-header, .column-header').length > 0;
      const hasMultipleRadioGroups = document.querySelectorAll('input[type="radio"]').length > 5;
      
      return hasTableRows && (hasColumnHeaders || hasMultipleRadioGroups);
    });
    
    if (isMatrixQuestion) {
      console.log("Detected a matrix/grid question");
      const handled = await handleMatrixQuestion(page);
      if (handled) return;
    }
    
    // Check if this is an age question
    const isAgeQuestion = pageContent.includes("age?") || pageContent.includes("QAge") || 
                          pageContent.includes("How old") || pageContent.includes("What is your age");
    
    // Check for number input requirements
    const requiresNumber = errorInfo?.inputType === "number" || 
                           (errorInfo?.errorMessage && (
                             errorInfo.errorMessage.includes("number") || 
                             errorInfo.errorMessage.includes("numeric") ||
                             errorInfo.errorMessage.includes("decimal")
                           ));
                           
    // If this is an age question or requires a number based on error feedback
    if (isAgeQuestion || requiresNumber) {
      console.log("This appears to be a numeric input question (age or other number)");
      
      const textInputs = await page.$$('input[type="text"], input[type="number"], textarea');
      if (textInputs.length > 0) {
        // Generate a random appropriate age (18-80)
        const randomAge = Math.floor(Math.random() * 63) + 18;
        console.log(`Entering numeric value: ${randomAge}`);
        
        // Clear any existing value first
        await textInputs[0].fill('');
        await textInputs[0].fill(randomAge.toString());
        
        // If this is coming from an error correction, try to understand exactly what was wrong
        if (errorInfo?.errorMessage) {
          // Use natural language to understand the error and fix it
          await page.act(`Fix the input error: "${errorInfo.errorMessage}" by entering the correct format`);
        }
        
        return;
      }
    }
    
    // First, try to get visible checkbox labels (the text next to each checkbox)
    const checkboxLabelsVisible = await page.$$eval('input[type="checkbox"]', 
      checkboxes => {
        return checkboxes.map(checkbox => {
          // Try to get the label that's associated with this checkbox
          let label = '';
          
          // First try finding an associated label by the 'for' attribute
          if (checkbox.id) {
            const labelElement = document.querySelector(`label[for="${checkbox.id}"]`);
            if (labelElement) {
              label = labelElement.textContent.trim();
            }
          }
          
          // If no label found, try finding the parent label
          if (!label && checkbox.closest('label')) {
            label = checkbox.closest('label').textContent.trim();
          }
          
          // If still no label, try getting text that's near the checkbox
          if (!label) {
            // Get the parent container
            const parent = checkbox.parentElement;
            if (parent) {
              label = parent.textContent.trim();
            }
          }
          
          return label;
        }).filter(label => label); // Filter out empty labels
      });
      
    if (checkboxLabelsVisible.length > 0) {
      console.log(`Found ${checkboxLabelsVisible.length} checkbox options with visible text`);
      
      // Select a random checkbox option by its visible text
      const randomIndex = Math.floor(Math.random() * checkboxLabelsVisible.length);
      const selectedOption = checkboxLabelsVisible[randomIndex];
      
      // Shorten the label to first 40 chars for logging
      const shortLabel = selectedOption.length > 40 ? selectedOption.substring(0, 37) + '...' : selectedOption;
      console.log(`Selecting checkbox option: "${shortLabel}"`);
      
      // Use the same approach as the industry handler
      let checkboxSelected = false;
      
      // Try using check with text selector
      try {
        await page.check(`text="${selectedOption}"`);
        checkboxSelected = true;
        console.log("Selected checkbox using text selector");
      } catch (error) {
        console.log("Error selecting with text selector:", error.message);
        
        // If exact text fails, try a partial text match
        try {
          // Get first few words for a more reliable selector
          const firstWords = selectedOption.split(' ').slice(0, 3).join(' ');
          await page.check(`text="${firstWords}"`);
          checkboxSelected = true;
          console.log("Selected checkbox using partial text selector");
        } catch (error2) {
          console.log("Error selecting with partial text selector:", error2.message);
        }
      }
      
      // If text-based selection failed, try direct selection
      if (!checkboxSelected) {
        try {
          // Try selecting a random checkbox directly
          const checkboxes = await page.$$('input[type="checkbox"]');
          if (checkboxes.length > 0) {
            await checkboxes[randomIndex].check();
            checkboxSelected = true;
            console.log("Selected checkbox directly by index");
          }
        } catch (error) {
          console.log("Error selecting checkbox directly:", error.message);
        }
      }
      
      // If all direct methods failed, use natural language
      if (!checkboxSelected) {
        console.log("All direct selection methods failed, using natural language");
        await page.act("Select a single random checkbox option");
      }
      
      // Now check if there's an "Other" text field that needs to be filled
      await page.waitForTimeout(500);
      
      try {
        // Look for any text inputs on the page
        const textInputs = await page.$$('input[type="text"], textarea');
        
        // Only fill a text input if we selected an "Other" option (check the label)
        if (selectedOption.toLowerCase().includes('other') && textInputs.length > 0) {
          const otherResponses = ["Other response", "Test input", "Additional information"];
          const randomResponse = otherResponses[Math.floor(Math.random() * otherResponses.length)];
          await textInputs[0].fill(randomResponse);
          console.log(`Filled "Other" text input with: "${randomResponse}"`);
        }
      } catch (error) {
        console.log("Error handling 'Other' text field:", error.message);
      }
      
      return;
    }
    
    // For radio buttons (single choice)
    const radioLabelsVisible = await page.$$eval('input[type="radio"]', 
      radios => {
        return radios.map(radio => {
          // Similar logic to get label text as for checkboxes
          let label = '';
          
          if (radio.id) {
            const labelElement = document.querySelector(`label[for="${radio.id}"]`);
            if (labelElement) {
              label = labelElement.textContent.trim();
            }
          }
          
          if (!label && radio.closest('label')) {
            label = radio.closest('label').textContent.trim();
          }
          
          if (!label) {
            const parent = radio.parentElement;
            if (parent) {
              label = parent.textContent.trim();
            }
          }
          
          return label;
        }).filter(label => label);
      });
      
    if (radioLabelsVisible.length > 0) {
      console.log(`Found ${radioLabelsVisible.length} radio button options with visible text`);
      
      // Select a random radio option
      const randomIndex = Math.floor(Math.random() * radioLabelsVisible.length);
      const selectedOption = radioLabelsVisible[randomIndex];
      
      // Shorten the label for logging
      const shortLabel = selectedOption.length > 40 ? selectedOption.substring(0, 37) + '...' : selectedOption;
      console.log(`Selecting radio option: "${shortLabel}"`);
      
      let radioSelected = false;
      
      // Try using click with text selector
      try {
        await page.click(`text="${selectedOption}"`);
        radioSelected = true;
        console.log("Selected radio button using text selector");
      } catch (error) {
        console.log("Error selecting with text selector:", error.message);
        
        // If exact text fails, try a partial text match
        try {
          const firstWords = selectedOption.split(' ').slice(0, 3).join(' ');
          await page.click(`text="${firstWords}"`);
          radioSelected = true;
          console.log("Selected radio button using partial text selector");
        } catch (error2) {
          console.log("Error selecting with partial text selector:", error2.message);
        }
      }
      
      // If text-based selection failed, try direct selection
      if (!radioSelected) {
        try {
          const radioButtons = await page.$$('input[type="radio"]');
          if (radioButtons.length > 0) {
            await radioButtons[randomIndex].click();
            radioSelected = true;
            console.log("Selected radio button directly by index");
          }
        } catch (error) {
          console.log("Error selecting radio button directly:", error.message);
        }
      }
      
      // If all direct methods failed, use natural language
      if (!radioSelected) {
        console.log("All direct selection methods failed, using natural language");
        await page.act("Select a single random radio button option");
      }
      
      // Now check if there's an "Other" text field that needs to be filled
      await page.waitForTimeout(500);
      
      try {
        const textInputs = await page.$$('input[type="text"], textarea');
        
        if (selectedOption.toLowerCase().includes('other') && textInputs.length > 0) {
          const otherResponses = ["Other response", "Test input", "Additional information"];
          const randomResponse = otherResponses[Math.floor(Math.random() * otherResponses.length)];
          await textInputs[0].fill(randomResponse);
          console.log(`Filled "Other" text input with: "${randomResponse}"`);
        }
      } catch (error) {
        console.log("Error handling 'Other' text field:", error.message);
      }
      
      return;
    }
    
    // For dropdown selects
    const selects = await page.$$('select');
    if (selects.length > 0) {
      for (const select of selects) {
        // Get all options
        const options = await select.$$('option');
        if (options.length > 1) { // Skip first option if it's a placeholder
          const randomIndex = Math.floor(Math.random() * (options.length - 1)) + 1;
          await select.selectOption({ index: randomIndex });
          console.log(`Selected dropdown option ${randomIndex} of ${options.length}`);
        }
      }
      return;
    }
    
    // For text inputs only (when it's the only input type on the page)
    const textInputs = await page.$$('input[type="text"], input[type="number"], textarea');
    const checkboxes = await page.$$('input[type="checkbox"]');
    const radioButtons = await page.$$('input[type="radio"]');
    
    if (textInputs.length > 0 && checkboxes.length === 0 && radioButtons.length === 0) {
      console.log("This appears to be a text-only question");
      
      for (const input of textInputs) {
        // Check for number type input fields
        const inputType = await input.evaluate(el => el.type);
        const placeholder = await input.evaluate(el => el.placeholder || '');
        
        // Check if this is likely a numeric field
        const isLikelyNumeric = 
          inputType === 'number' || 
          placeholder.includes('age') || 
          placeholder.includes('number') ||
          pageContent.includes('age') ||
          pageContent.includes('old are you');
          
        if (isLikelyNumeric || requiresNumber) {
          // Generate a random number appropriate for an age (18-80)
          const randomNumber = Math.floor(Math.random() * 63) + 18;
          await input.fill(randomNumber.toString());
          console.log(`Filled numeric input with: ${randomNumber}`);
        } else {
          // Generate a random text response
          const responses = [
            "This is my response",
            "Survey testing",
            "Automation test",
            "Testing 123",
            "Placeholder answer"
          ];
          const randomResponse = responses[Math.floor(Math.random() * responses.length)];
          await input.fill(randomResponse);
          console.log(`Filled text input with: "${randomResponse}"`);
        }
      }
      return;
    }
    
    // For slider/range inputs
    const sliders = await page.$$('input[type="range"]');
    if (sliders.length > 0) {
      for (const slider of sliders) {
        // Set a random value
        const min = await slider.getAttribute('min') || 0;
        const max = await slider.getAttribute('max') || 100;
        const randomValue = Math.floor(Math.random() * (max - min + 1)) + min;
        await slider.fill(randomValue.toString());
        console.log(`Set slider to value: ${randomValue}`);
      }
      return;
    }
    
    // If we couldn't identify the question type using direct methods, use Stagehand's natural language
    console.log("Could not identify question type, using natural language fallback");
    await page.act("Select a random answer option for this question");
    
  } catch (error) {
    console.log("Error in handleGenericQuestionPage:", error);
    console.log("Falling back to Stagehand's natural language capabilities");
    await page.act("Select a random answer for this question");
  }

}

async function handleMatrixQuestion(page) {
  // Your existing implementation
  console.log("Handling matrix/grid question...");
    
  try {
    // First, get the column headers to identify which column contains "Somewhat unfavorable"
    const columnInfo = await page.evaluate(() => {
      const headers = Array.from(document.querySelectorAll('th'));
      return headers.map((th, index) => ({
        index,
        text: th.textContent.trim(),
        id: th.id || '',
        class: th.className || '',
        colIndex: th.getAttribute('col') || ''
      }));
    });
    
    //console.log("Column headers:", columnInfo);
    
    // Find which column contains "Somewhat unfavorable"
    let unfavorableColIndex = -1;
    for (const col of columnInfo) {
      if (col.text.toLowerCase().includes("somewhat unfavorable")) {
        unfavorableColIndex = col.colIndex || col.index;
        console.log(`Found "Somewhat unfavorable" at column index ${unfavorableColIndex}`);
        break;
      }
    }
    
    // Now find the attention check row
    const rowInfo = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tr'));
      return rows.map((row, index) => {
        const text = row.textContent.trim();
        const hasRadios = row.querySelectorAll('input[type="radio"]').length > 0;
        return {
          index,
          text: text.length > 100 ? text.substring(0, 100) + '...' : text,
          hasRadios,
          isAttentionCheck: text.toLowerCase().includes('please select')
        };
      });
    });
    
    //console.log("Row info:", rowInfo);
    
    // Find the attention check row
    const attentionRow = rowInfo.find(row => row.isAttentionCheck);
    
    if (attentionRow && unfavorableColIndex !== -1) {
      console.log(`Found attention check row ${attentionRow.index}, need to select column ${unfavorableColIndex}`);
      
      // First try using the most direct selector based on the HTML structure
      try {
        await page.evaluate(({rowIndex, colIndex}) => {
          const row = document.querySelectorAll('tr')[rowIndex];
          if (!row) throw new Error(`Row ${rowIndex} not found`);
          
          // Try to find the radio input in this row with the matching column index
          const radio = row.querySelector(`input[type="radio"][id$="-${colIndex}"]`) || 
                       row.querySelector(`input[type="radio"][id*="-${colIndex}"]`);
          
          if (radio) {
            console.log(`Found radio button with column index ${colIndex} in row ${rowIndex}`);
            radio.click();
            return true;
          }
          
          // Alternative approach: get all radio buttons in the row and select the one at position matching the column
          const radios = Array.from(row.querySelectorAll('input[type="radio"]'));
          if (radios.length > 0) {
            // Adjust for zero-based indexing if needed
            const adjustedIndex = Math.min(parseInt(colIndex) - 1, radios.length - 1);
            if (adjustedIndex >= 0) {
              console.log(`Clicking radio at adjusted index ${adjustedIndex}`);
              radios[adjustedIndex].click();
              return true;
            }
          }
          
          return false;
        }, {rowIndex: attentionRow.index, colIndex: unfavorableColIndex});
      } catch (error) {
        console.log("Error selecting attention check option:", error);
      }
    }
    
    // Now make sure all rows have a selection
    const rowsWithRadios = rowInfo.filter(row => row.hasRadios);
    console.log(`Processing ${rowsWithRadios.length} rows with radio buttons`);
    
    for (const row of rowsWithRadios) {
      // Check if this row already has a selection
      const hasSelection = await page.evaluate((rowIndex) => {
        const row = document.querySelectorAll('tr')[rowIndex];
        if (!row) return false;
        return row.querySelector('input[type="radio"]:checked') !== null;
      }, row.index);
      
      if (!hasSelection) {
        console.log(`Row ${row.index} needs selection`);
        
        // For non-attention check rows, select a random option
        if (!row.isAttentionCheck) {
          await page.evaluate((rowIndex) => {
            const row = document.querySelectorAll('tr')[rowIndex];
            if (!row) return;
            
            const radios = Array.from(row.querySelectorAll('input[type="radio"]'));
            if (radios.length > 0) {
              const randomIndex = Math.floor(Math.random() * radios.length);
              radios[randomIndex].click();
              console.log(`Selected random option ${randomIndex} for row ${rowIndex}`);
            }
          }, row.index);
        }
      }
    }
    
    // Final verification
    const verification = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tr')).filter(row => 
        row.querySelectorAll('input[type="radio"]').length > 0
      );
      
      const results = [];
      for (let i = 0; i < rows.length; i++) {
        const checked = rows[i].querySelector('input[type="radio"]:checked') !== null;
        results.push({
          rowIndex: i,
          hasSelection: checked,
          text: rows[i].textContent.trim().substring(0, 30)
        });
      }
      
      return results;
    });
    
    //console.log("Selection verification:", verification);
    
    // If we still have rows without selections, use direct coordinate-based clicking
    const missingRows = verification.filter(v => !v.hasSelection);
    if (missingRows.length > 0) {
      console.log(`Still have ${missingRows.length} rows without selections, using coordinate approach`);
      
      // Get coordinates of all radio buttons
      const buttonCoords = await page.evaluate(() => {
        const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
        return radios.map(radio => {
          const rect = radio.getBoundingClientRect();
          const row = getAncestorByTagName(radio, 'tr');
          const rowIndex = row ? Array.from(document.querySelectorAll('tr')).indexOf(row) : -1;
          
          return {
            x: rect.left + rect.width/2,
            y: rect.top + rect.height/2,
            rowIndex,
            checked: radio.checked,
            id: radio.id
          };
          
          function getAncestorByTagName(el, tagName) {
            while (el && el.tagName !== tagName.toUpperCase()) {
              el = el.parentElement;
            }
            return el;
          }
        });
      });
      
      // Group buttons by row
      const buttonsByRow = {};
      for (const btn of buttonCoords) {
        if (btn.rowIndex === -1) continue;
        
        if (!buttonsByRow[btn.rowIndex]) {
          buttonsByRow[btn.rowIndex] = [];
        }
        buttonsByRow[btn.rowIndex].push(btn);
      }
      
      // For each missing row, click a random button
      for (const missingRow of missingRows) {
        const buttonsInRow = buttonsByRow[missingRow.rowIndex] || [];
        if (buttonsInRow.length > 0) {
          // For attention check row, try to click the "Somewhat unfavorable" option
          if (missingRow.text.toLowerCase().includes('please select')) {
            // Look for button with ID containing the unfavorable column index
            const unfavorableButton = buttonsInRow.find(btn => 
              btn.id.includes(`-${unfavorableColIndex}`)
            );
            
            if (unfavorableButton) {
              console.log(`Clicking attention check option with coordinates ${unfavorableButton.x},${unfavorableButton.y}`);
              await page.mouse.click(unfavorableButton.x, unfavorableButton.y);
            } else {
              // If we can't identify the right button, try clicking the 4th button (common position for "Somewhat unfavorable")
              const targetIndex = Math.min(3, buttonsInRow.length - 1);
              console.log(`Clicking likely attention check option at index ${targetIndex}`);
              await page.mouse.click(buttonsInRow[targetIndex].x, buttonsInRow[targetIndex].y);
            }
          } else {
            // For regular rows, click a random button
            const randomBtn = buttonsInRow[Math.floor(Math.random() * buttonsInRow.length)];
            console.log(`Clicking random option for row ${missingRow.rowIndex} at ${randomBtn.x},${randomBtn.y}`);
            await page.mouse.click(randomBtn.x, randomBtn.y);
          }
          
          // Small delay between clicks
          await page.waitForTimeout(100);
        }
      }
    }
    
    console.log("Completed matrix question selection");
    return true;
  } catch (error) {
    console.log("Error handling matrix question:", error);
    
    // Last resort - specific instructions for Stagehand
    await page.act("For the row that says 'Please select Somewhat unfavorable for this item', click the option labeled 'Somewhat unfavorable'. For all other rows, select any option randomly.");
    
    return true;
  }

}

completeSurvey().catch(error => {
  console.error("Survey automation failed:", error);
  process.exit(1);
});