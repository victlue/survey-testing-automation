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

// Endpoint to run the survey automation
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
    customQuestions
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});