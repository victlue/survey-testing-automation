import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/build')));

// Endpoint to run the survey automation in headed mode
app.post('/api/runSurvey', (req, res) => {
  const { surveyUrl, customQuestions } = req.body;
  
  if (!surveyUrl) {
    return res.status(400).json({ error: 'Survey URL is required' });
  }
  
  // Set up response for streaming
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Transfer-Encoding', 'chunked');
  
  // Generate a temporary config file for this run
  const configFile = path.join(__dirname, `temp-config-${Date.now()}.json`);
  fs.writeFileSync(configFile, JSON.stringify({
    surveyUrl,
    customQuestions,
    headless: false
  }));
  
  // Spawn the survey automation process
  const surveyProcess = spawn('node', [path.join(__dirname, 'survey-runner.js'), configFile]);
  
  // Stream output back to client
  surveyProcess.stdout.on('data', (data) => {
    res.write(data);
  });
  
  surveyProcess.stderr.on('data', (data) => {
    res.write(`Error: ${data}\n`);
  });
  
  surveyProcess.on('close', (code) => {
    res.write(`Process exited with code ${code}\n`);
    
    // Clean up temp file
    try {
      fs.unlinkSync(configFile);
    } catch (err) {
      console.error('Error deleting temp file:', err);
    }
    
    res.end();
  });
});

// New endpoint to run multiple headless survey tests concurrently
app.post('/api/runHeadlessTests', (req, res) => {
  const { surveyUrl, customQuestions, count = 1 } = req.body;
  
  if (!surveyUrl) {
    return res.status(400).json({ error: 'Survey URL is required' });
  }
  
  // Validate count (1-5)
  const runCount = Math.min(5, Math.max(1, parseInt(count)));
  
  // Set up response for streaming
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Transfer-Encoding', 'chunked');
  
  res.write(`Starting ${runCount} concurrent headless survey test runs...\n`);
  
  // Keep track of completed processes
  let completedProcesses = 0;
  const startTime = Date.now();
  
  // Start each process
  for (let i = 0; i < runCount; i++) {
    const runId = i + 1;
    
    // Generate a temporary config file for this run
    const configFile = path.join(__dirname, `temp-config-${Date.now()}-${runId}.json`);
    fs.writeFileSync(configFile, JSON.stringify({
      surveyUrl,
      customQuestions,
      headless: true,
      runId
    }));
    
    res.write(`Starting test run #${runId}...\n`);
    
    // Spawn the survey automation process with ENV flag to use Browserbase if available
    const surveyProcess = spawn('node', [path.join(__dirname, 'survey-runner.js'), configFile], {
      env: {
        ...process.env,
        USE_BROWSERBASE: 'true'
      }
    });
    
    // Stream output back to client with run ID prefix
    surveyProcess.stdout.on('data', (data) => {
      const output = data.toString()
        .split('\n')
        .filter(line => line.trim())
        .map(line => `[Run #${runId}] ${line}`)
        .join('\n') + '\n';
      
      res.write(output);
    });
    
    surveyProcess.stderr.on('data', (data) => {
      res.write(`[Run #${runId}] Error: ${data}\n`);
    });
    
    surveyProcess.on('close', (code) => {
      completedProcesses++;
      
      const runTime = ((Date.now() - startTime) / 1000).toFixed(2);
      res.write(`[Run #${runId}] Test run complete (exit code: ${code}) - Runtime: ${runTime}s\n`);
      
      // Clean up temp file
      try {
        fs.unlinkSync(configFile);
      } catch (err) {
        console.error(`Error deleting temp file for run #${runId}:`, err);
      }
      
      // If all processes are complete, end the response
      if (completedProcesses === runCount) {
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
        res.write(`\nAll ${runCount} test runs completed in ${totalTime} seconds.\n`);
        res.end();
      }
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});