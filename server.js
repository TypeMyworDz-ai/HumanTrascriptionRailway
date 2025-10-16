const express = require('express');
const cors = require('cors');
require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');
const supabase = require('./database');

// Import routes
const authRoutes = require('./routes/authRoutes');
const audioRoutes = require('./routes/audioRoutes');
const transcriberRoutes = require('./routes/transcriberRoutes'); // Use the consolidated transcriber routes
const generalApiRoutes = require('./routes/generalApiRoutes'); // Use the new general API routes

const app = express();
const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Requested-With", "X-HTTP-Method-Override"],
    credentials: true
  },
  allowEIO3: true
});

app.use(cors({
  origin: 'http://localhost:3000',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With', 'X-HTTP-Method-Override'],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Pass the io instance to your router setup functions
const transcriberRouter = transcriberRoutes(io);
const generalApiRouter = generalApiRoutes(io); // io instance passed here

// --- ROUTES ---
// Mount transcriber-specific routes under /api/transcriber
app.use('/api/transcriber', transcriberRouter);

app.use('/api/auth', authRoutes);
app.use('/api/audio', audioRoutes);

// Mount general API routes (including client-specific negotiations and transcriber pool) under /api
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

// Removed the io.on('connection', ...) block from here.
// This logic is now handled within generalApiRoutes.js which receives the 'io' instance.

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log('Socket.IO is listening for connections.');
});

module.exports = { io, server, app };
