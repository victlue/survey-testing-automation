import React, { useState, useEffect } from 'react';
import './App.css';

function App() {
  const [surveyUrl, setSurveyUrl] = useState('');
  const [customQuestions, setCustomQuestions] = useState([
    { 
      id: 'question-1',
      questionName: 'QFirstName', 
      identifier: 'First Name',
      options: [
        { text: 'Victor', probability: 100 }
      ]
    },
    { 
      id: 'question-2',
      questionName: 'QLastName', 
      identifier: 'Last Name',
      options: [
        { text: 'Lue', probability: 100 }
      ]
    },
    { 
      id: 'question-3',
      questionName: 'QZip', 
      identifier: 'Zip code as listed on your voter registration',
      options: [
        { text: '10583', probability: 90 },
        { text: '33109', probability: 10 }
      ]
    },
    { 
      id: 'question-4',
      questionName: 'QState', 
      identifier: 'In what state do you live?',
      options: [
        { text: 'New York', probability: 90 },
        { text: 'Texas', probability: 10 }
      ]
    },
    { 
      id: 'question-5',
      questionName: 'QIndustry', 
      identifier: 'What industry do you work in?',
      options: [
        { text: 'Journalism or the media', probability: 5 },
        { text: 'Market research', probability: 5 },
        { text: 'Public relations', probability: 5 },
        { text: 'Food service or the restaurant industry', probability: 17 },
        { text: 'Healthcare or the pharmaceutical industry', probability: 17 },
        { text: 'Technology', probability: 17 },
        { text: 'Sales', probability: 17 },
        { text: 'None of these', probability: 17 }
      ]
    },
    {
      id: 'question-6',
      questionName: 'QGender',
      identifier: 'Do you describe yourself as a man, a woman, or in some other way?',
      options: [
        { text: 'Man', probability: 33 },
        { text: 'Woman', probability: 33 },
        { text: 'In some other way', probability: 34 }
      ]
    },
    {
      id: 'question-7',
      questionName: 'QRegVote',
      identifier: 'Are you registered to vote?',
      options: [
        { text: 'Yes', probability: 80 },
        { text: 'No', probability: 10 },
        { text: 'Unsure', probability: 10 }
      ]
    },
    {
      id: 'question-8',
      questionName: 'QAge',
      identifier: 'What is your age?',
      options: [
        { text: '45', probability: 100 }
      ]
    },
    {
      id: 'question-9',
      questionName: 'TRAP',
      identifier: 'Are you licensed to operate a class SSGN submarine?',
      options: [
        { text: 'No', probability: 100 }
      ]
    }
  ]);
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState([]);
  const [concurrentRuns, setConcurrentRuns] = useState(1);
  const [completedRuns, setCompletedRuns] = useState(0);
  
  const handleAddQuestion = () => {
    setCustomQuestions([...customQuestions, {
      id: `question-${customQuestions.length + 1}`,
      questionName: '',
      identifier: '',
      options: [
        { text: 'Option 1', probability: 50 },
        { text: 'Option 2', probability: 50 }
      ]
    }]);
  };
  
  const handleRemoveQuestion = (id) => {
    setCustomQuestions(customQuestions.filter(q => q.id !== id));
  };
  
  const handleQuestionChange = (id, field, value) => {
    setCustomQuestions(customQuestions.map(q => 
      q.id === id ? { ...q, [field]: value } : q
    ));
  };
  
  const handleOptionChange = (questionId, optionIndex, field, value) => {
    setCustomQuestions(customQuestions.map(q => {
      if (q.id === questionId) {
        const updatedOptions = [...q.options];
        updatedOptions[optionIndex] = { 
          ...updatedOptions[optionIndex], 
          [field]: field === 'probability' ? Number(value) : value 
        };
        return { ...q, options: updatedOptions };
      }
      return q;
    }));
  };
  
  const handleAddOption = (questionId) => {
    setCustomQuestions(customQuestions.map(q => {
      if (q.id === questionId) {
        return {
          ...q,
          options: [...q.options, { text: '', probability: 0 }]
        };
      }
      return q;
    }));
  };
  
  const handleRemoveOption = (questionId, optionIndex) => {
    setCustomQuestions(customQuestions.map(q => {
      if (q.id === questionId) {
        const updatedOptions = [...q.options];
        updatedOptions.splice(optionIndex, 1);
        return { ...q, options: updatedOptions };
      }
      return q;
    }));
  };
  
  const validateProbabilities = (questionId) => {
    const question = customQuestions.find(q => q.id === questionId);
    if (!question) return false;
    
    const sum = question.options.reduce((acc, option) => acc + option.probability, 0);
    //return Math.abs(sum - 100) < 0.01; // Allow small floating point differences
    return Math.abs(sum - 100) < 1000;
  };
  
  const validateConcurrentRuns = (value) => {
    const num = parseInt(value);
    return !isNaN(num) && num > 0 && num <= 5 && Number.isInteger(num);
  };
  
  const handleConcurrentRunsChange = (e) => {
    const value = e.target.value;
    if (value === '' || validateConcurrentRuns(value)) {
      setConcurrentRuns(value);
    }
  };
  
  const runTest = async (headless = false, count = 1) => {
    if (!surveyUrl) {
      alert('Please enter a survey URL');
      return;
    }
    
    // Validate all probabilities add up to 100%
    const invalidQuestions = customQuestions.filter(q => !validateProbabilities(q.id));
    if (invalidQuestions.length > 0) {
      alert(`The following questions have probabilities that don't sum to 100%: ${invalidQuestions.map(q => q.questionName || q.identifier).join(', ')}`);
      return;
    }
    
    setIsRunning(true);
    setLogs([`Starting survey test run${headless ? 's' : ''}...`]);
    
    if (headless) {
      setCompletedRuns(0);
    }
    
    try {
      const endpoint = headless ? '/api/runHeadlessTests' : '/api/runSurvey';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          surveyUrl,
          customQuestions,
          count: headless ? count : 1
        }),
      });
      
      if (response.ok) {
        // Set up streaming for logs
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const text = decoder.decode(value);
          const newLogs = text.split('\n').filter(line => line.trim());
          
          setLogs(prevLogs => [...prevLogs, ...newLogs]);
          
          // Check for test completion messages
          if (headless) {
            const completedCount = newLogs.filter(log => 
              log.includes("Test run complete") || 
              log.includes("Survey processing complete")).length;
            
            if (completedCount > 0) {
              setCompletedRuns(prev => prev + completedCount);
            }
          }
        }
      } else {
        setLogs(prevLogs => [...prevLogs, 'Error: Failed to start test run']);
      }
    } catch (error) {
      setLogs(prevLogs => [...prevLogs, `Error: ${error.message}`]);
    } finally {
      setIsRunning(false);
    }
  };
  
  const runHeadlessTests = () => {
    if (!validateConcurrentRuns(concurrentRuns)) {
      alert('Please enter a valid number of concurrent runs (1-5)');
      return;
    }
    
    runTest(true, parseInt(concurrentRuns));
  };
  
  // Scroll to bottom of logs when new entries are added
  useEffect(() => {
    const logsContainer = document.querySelector('.logs');
    if (logsContainer) {
      logsContainer.scrollTop = logsContainer.scrollHeight;
    }
  }, [logs]);
  
  return (
    <div className="app">
      <h1>Survey Test Runner</h1>
      
      <div className="config-section">
        <h2>Survey Configuration</h2>
        
        <div className="form-group">
          <label>Survey URL:</label>
          <input 
            type="text" 
            value={surveyUrl} 
            onChange={(e) => setSurveyUrl(e.target.value)}
            placeholder="https://survey.alchemer.com/s3/..."
            disabled={isRunning}
          />
        </div>
        
        <h3>Custom Question Handling</h3>
        <p className="info-text">
          Specify questions that should have customized answer distributions. 
          Any questions not listed here will be answered randomly.
        </p>
        
        {customQuestions.map((question, index) => (
          <div key={question.id} className="question-config">
            <h4>Question {index + 1}</h4>
            
            <div className="form-group">
              <label>Question Name (e.g., QIndustry):</label>
              <input
                type="text"
                value={question.questionName}
                onChange={(e) => handleQuestionChange(question.id, 'questionName', e.target.value)}
                disabled={isRunning}
              />
            </div>
            
            <div className="form-group">
              <label>Identifier Text (text that appears on page):</label>
              <input
                type="text"
                value={question.identifier}
                onChange={(e) => handleQuestionChange(question.id, 'identifier', e.target.value)}
                disabled={isRunning}
              />
            </div>
            
            <h5>Answer Options</h5>
            <div className="options-header">
              <div className="option-text-header">Option Text</div>
              <div className="option-probability-header">Probability (%)</div>
            </div>
            
            {question.options.map((option, optionIndex) => (
              <div key={optionIndex} className="option-row">
                <input
                  type="text"
                  value={option.text}
                  onChange={(e) => handleOptionChange(question.id, optionIndex, 'text', e.target.value)}
                  className="option-text"
                  disabled={isRunning}
                />
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={option.probability}
                  onChange={(e) => handleOptionChange(question.id, optionIndex, 'probability', e.target.value)}
                  className="option-probability"
                  disabled={isRunning}
                />
                <button 
                  onClick={() => handleRemoveOption(question.id, optionIndex)}
                  disabled={question.options.length <= 1 || isRunning}
                  className="remove-btn"
                >
                  Remove
                </button>
              </div>
            ))}
            
            <div className="option-buttons">
              <button 
                onClick={() => handleAddOption(question.id)}
                disabled={isRunning}
                className="add-option-btn"
              >
                Add Option
              </button>
              
              <div className={`probability-indicator ${validateProbabilities(question.id) ? 'valid' : 'invalid'}`}>
                Total: {question.options.reduce((sum, opt) => sum + opt.probability, 0).toFixed(1)}%
                {validateProbabilities(question.id) ? ' ✓' : ' ✗'}
              </div>
            </div>
            
            <div className="question-actions">
              <button 
                onClick={() => handleRemoveQuestion(question.id)}
                disabled={isRunning}
                className="remove-question-btn"
              >
                Remove Question
              </button>
            </div>
          </div>
        ))}
        
        <div className="add-question">
          <button 
            onClick={handleAddQuestion}
            disabled={isRunning}
            className="add-question-btn"
          >
            Add Question
          </button>
        </div>
        
        <div className="run-test">
          <button 
            onClick={() => runTest(false)}
            disabled={isRunning}
            className="run-test-btn"
          >
            {isRunning ? 'Running Test...' : 'Generate Headed Test Run'}
          </button>
        </div>
        
        <div className="run-headless-test">
          <div className="headless-controls">
            <div className="concurrent-input">
              <label htmlFor="concurrent-runs">Number of runs (1-5):</label>
              <input
                id="concurrent-runs"
                type="number"
                min="1"
                max="5"
                value={concurrentRuns}
                onChange={handleConcurrentRunsChange}
                disabled={isRunning}
              />
            </div>
            <button 
              onClick={runHeadlessTests}
              disabled={isRunning}
              className="run-test-btn headless-btn"
            >
              {isRunning ? `Running Tests (${completedRuns}/${concurrentRuns} complete)` : 'Generate Headless Test Responses'}
            </button>
          </div>
        </div>
      </div>
      
      {logs.length > 0 && (
        <div className="logs-section">
          <h2>Test Run Logs</h2>
          <div className="logs">
            {logs.map((log, index) => (
              <div key={index} className="log-entry">{log}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;