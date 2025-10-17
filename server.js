const express = require('express');
const cors = require('cors');
require('dotenv').config(); // Load environment variables from .env file
const http = require('http');
const { Server } = require('socket.io');
const supabase = require('./database');

// Import routes and controllers
const authRoutes = require('./routes/authRoutes');
const audioRoutes = require('./routes/audioRoutes');
const transcriberRoutes = require('./routes/transcriberRoutes');
const generalApiRoutes = require('./routes/generalApiRoutes');

// Import setOnlineStatus from transcriberController
const { setOnlineStatus } = require('./controllers/transcriberController');

const app = express();
// Use Railway's PORT environment variable or fallback to 5000 for local development
const PORT = process.env.PORT || 5000;

// Define allowed origins for CORS dynamically
const ALLOWED_ORIGINS = [
  'http://localhost:3000', // Frontend local development
  process.env.CLIENT_URL,   // Vercel Frontend URL (e.g., https://human-transcription-frontend-vercel.vercel.app)
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

// NEW: Socket.IO Connection and Disconnection Logic for is_online status
io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId;
  console.log(`User connected via WebSocket: ${socket.id} (User ID: ${userId || 'N/A'})`);

  if (userId) {
    // Store userId on the socket for later use on disconnect
    socket.userId = userId;

    // Check if this user is a transcriber and set them online
    supabase.from('users').select('user_type').eq('id', userId).single()
      .then(({ data, error }) => {
        if (error) {
          console.error(`Error fetching user type for socket connection ${userId}:`, error);
          return;
        }
        if (data && data.user_type === 'transcriber') {
          setOnlineStatus(userId, true)
            .then(() => console.log(`Transcriber ${userId} set to online on socket connect.`))
            .catch(err => console.error(`Failed to set transcriber ${userId} online on connect:`, err));
        }
      });

    socket.on('joinUserRoom', (roomUserId) => {
      if (roomUserId === userId) {
        socket.join(roomUserId);
        console.log(`Socket ${socket.id} joined room for user ${roomUserId}`);
      } else {
        console.warn(`Attempted to join incorrect room. Socket ID: ${socket.id}, Query User ID: ${userId}, Requested Room User ID: ${roomUserId}`);
      }
    });
  } else {
    console.warn(`Socket connected without a userId in query. Socket ID: ${socket.id}`);
  }


  socket.on('disconnect', (reason) => {
    console.log(`User disconnected from WebSocket: ${socket.id} (Reason: ${reason})`);
    if (socket.userId) {
      // Set transcriber offline on disconnect
      supabase.from('users').select('user_type').eq('id', socket.userId).single()
        .then(({ data, error }) => {
          if (error) {
            console.error(`Error fetching user type for socket disconnect ${socket.userId}:`, error);
            return;
          }
          if (data && data.user_type === 'transcriber') {
            setOnlineStatus(socket.userId, false)
              .then(() => console.log(`Transcriber ${socket.userId} set to offline on socket disconnect.`))
              .catch(err => console.error(`Failed to set transcriber ${socket.userId} offline on disconnect:`, err));
          }
        });
    }
  });

  // Handle errors on the socket
  socket.on('error', (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
  });
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
  console.log('Allowed CORS Origins:', ALLOWED_ORIGINS);
});

module.exports = { io, server, app };
