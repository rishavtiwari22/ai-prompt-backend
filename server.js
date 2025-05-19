const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(bodyParser.json());

// MongoDB Connection (optional - if you want to store prompts/results)
if (process.env.MONGO_URI) {
  const mongoUri = process.env.MONGO_URI;
  mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.error('MongoDB connection error:', err));

  // Define a simple PromptResult schema
  const promptResultSchema = new mongoose.Schema({
    scenario: String,
    difficulty: String,
    userPrompt: String,
    feedback: Object,
    timestamp: { type: Date, default: Date.now }
  });

  const PromptResult = mongoose.model('PromptResult', promptResultSchema);
}

// API Endpoint to analyze prompt
app.post('/api/analyze', async (req, res) => {
  try {
    const { scenario, difficulty, userPrompt } = req.body;

    if (!scenario || !difficulty || !userPrompt) {
      return res.status(400).json({ 
        error: 'Required fields missing', 
        isFallback: true 
      });
    }

    // Initialize Google Generative AI with API key
    // First check the request body for an API key (sent from frontend)
    // Then fall back to the environment variable
    const API_KEY = req.body.apiKey || process.env.GEMINI_API_KEY;
    if (!API_KEY) {
      return res.status(400).json({ 
        error: 'API key is required. Please configure it in the backend .env file or provide it through the frontend settings.', 
        isFallback: true 
      });
    }

    const genAI = new GoogleGenerativeAI(API_KEY);
    
    // Try multiple models in case one doesn't work
    const models = [
      "gemini-2.0-flash",
      "gemini-1.5-flash",
      "gemini-1.5-pro",
      "gemini-pro"
    ];
    
    let response = null;
    let error = null;
    
    // Debug info
    console.log(`API Key present: ${API_KEY ? "Yes" : "No"}`);
    console.log(`API Key length: ${API_KEY ? API_KEY.length : 0}`);
    
    // Try each model until one works
    for (const model of models) {
      try {
        console.log(`Trying model: ${model}`);
        const genModel = genAI.getGenerativeModel({ model: model });
        
        // Define the prompt
        const prompt = `You are an expert prompt engineer evaluating a user's AI prompt based on a specific scenario.
        
        Scenario: "${scenario}"
        
        Difficulty level: ${difficulty}
        
        User's prompt:
        "${userPrompt}"
        
        Evaluate how effectively the user's prompt would get good results from an AI for the given scenario.
        Be critical and honest in your assessment. For ${difficulty} difficulty, ${difficulty === 'beginner' ? 'be somewhat forgiving but still provide useful feedback.' : difficulty === 'intermediate' ? 'use moderately strict standards.' : 'apply very strict professional standards.'}
        
        Analyze the prompt's quality and provide feedback as a valid JSON object with exactly this structure:
        {
            "overallScore": [a realistic score from 1-10, don't be overly generous],
            "detailedFeedback": [one paragraph of specific analysis about strengths and weaknesses],
            "skillRatings": [
                {"name": "Clarity", "score": [1-10]},
                {"name": "Specificity", "score": [1-10]},
                {"name": "Structure", "score": [1-10]},
                {"name": "Context", "score": [1-10]},
                {"name": "Grammar & Syntax", "score": [1-10]}
            ],
            "improvementTips": [
                [specific improvement tip 1],
                [specific improvement tip 2],
                [specific improvement tip 3],
                [specific improvement tip 4],
                [specific improvement tip 5]
            ],
            "examplePrompts": [
                [example of a better prompt for this scenario 1],
                [example of a better prompt for this scenario 2]
            ]
        }
        
        Return ONLY the JSON response, nothing else.`;
        
        // Generate content
        response = await genModel.generateContent(prompt);
        
        // If we reach here, the model worked
        console.log(`Successfully used model: ${model}`);
        break;
      } catch (modelError) {
        console.error(`Error with model ${model}:`, modelError);
        // Extract more useful error message
        let errorMessage = `Error with model ${model}`;
        
        if (modelError.message) {
          errorMessage = modelError.message;
          // Check for common API key issues
          if (errorMessage.includes("API key") || errorMessage.includes("authentication")) {
            console.error("❌ API KEY ERROR:", errorMessage);
          }
        }
        
        error = {
          message: errorMessage,
          stack: modelError.stack,
          model: model
        };
      }
    }
    
    if (response) {
      const responseText = response.response.text();
      console.log("Raw feedback text:", responseText);
      
      // Extract JSON from the response text
      const jsonStartIndex = responseText.indexOf('{');
      const jsonEndIndex = responseText.lastIndexOf('}') + 1;
      if (jsonStartIndex >= 0 && jsonEndIndex > jsonStartIndex) {
        const feedbackJson = responseText.substring(jsonStartIndex, jsonEndIndex);
        try {
          const parsedFeedback = JSON.parse(feedbackJson);
          console.log("Parsed feedback:", parsedFeedback);
          
          // Save to MongoDB if connection exists and PromptResult model is defined
          if (mongoose.connection.readyState === 1 && mongoose.models.PromptResult) {
            try {
              const newResult = new mongoose.models.PromptResult({ 
                scenario, 
                difficulty, 
                userPrompt, 
                feedback: parsedFeedback 
              });
              await newResult.save();
              console.log("Saved feedback to MongoDB");
            } catch (dbError) {
              console.error("Error saving to DB:", dbError);
            }
          }
          
          return res.json(parsedFeedback);
        } catch (parseError) {
          console.error("Error parsing feedback JSON:", parseError);
          return res.status(500).json({ 
            error: 'Failed to parse AI response', 
            isFallback: true 
          });
        }
      }
    }
    
    // If all models failed or couldn't parse
    return res.status(500).json({ 
      error: error ? error.message : 'All models failed', 
      modelsTried: models,
      lastError: error,
      apiKeyProvided: !!API_KEY,
      apiKeyLength: API_KEY ? API_KEY.length : 0,
      isFallback: true 
    });
    
  } catch (error) {
    console.error("Error analyzing prompt:", error);
    return res.status(500).json({ 
      error: error.message || 'Failed to analyze prompt', 
      isFallback: true 
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(port, () => {
  console.log(`Backend server listening on port ${port}`);
});
