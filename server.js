const express = require('express');
const cors = require('cors');
require('dotenv').config(); // Load environment variables from .env file
const http = require('http');
const { Server } = require('socket.io');
const supabase = require('./database');

// Import routes
const authRoutes = require('./routes/authRoutes');
const audioRoutes = require('./routes/audioRoutes');
const transcriberRoutes = require('./routes/transcriberRoutes');
const generalApiRoutes = require('./routes/generalApiRoutes');

const app = express();
// Use Railway's PORT environment variable or fallback to 5000 for local development
const PORT = process.env.PORT || 5000; 

// Define allowed origins for CORS dynamically
// For local development, it will be 'http://localhost:3000'
// For Railway/Vercel, these will be set as environment variables
const ALLOWED_ORIGINS = [
  'http://localhost:3000', // Frontend local development
  process.env.CLIENT_URL,   // Vercel Frontend URL (e.g., https://your-frontend.vercel.app)
  process.env.RAILWAY_BACKEND_URL // Railway Backend URL (e.g., https://your-backend.up.railway.app)
].filter(Boolean); // Filter out any undefined/null values

const server = http.createServer(app);

// Configure Socket.IO server with dynamic CORS
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS, // Use the dynamic origins
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Requested-With", "X-HTTP-Method-Override"],
    credentials: true
  },
  allowEIO3: true
});

// Configure Express app with dynamic CORS
app.use(cors({
  origin: ALLOWED_ORIGINS, // Use the dynamic origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With', 'X-HTTP-Method-Override'],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Pass the io instance to your router setup functions
const transcriberRouter = transcriberRoutes(io);
const generalApiRouter = generalApiRoutes(io);

// --- ROUTES ---
app.use('/api/transcriber', transcriberRouter);
app.use('/api/auth', authRoutes);
app.use('/api/audio', audioRoutes);
app.use('/api', generalApiRouter);

// Test database connection
app.get('/test-db', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*').limit(1);
    if (error) throw error;
    res.json({ message: 'Database connected successfully!', data });
  } catch (error) {
    res.status(500).json({ message: 'Database connection failed', error: error.message });
  }
});

// Basic route for testing
app.get('/', (req, res) => {
  res.json({ message: 'Human Transcription API is running!' });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log('Socket.IO is listening for connections.');
  console.log('Allowed CORS Origins:', ALLOWED_ORIGINS); // Log for debugging
});

module.exports = { io, server, app };
