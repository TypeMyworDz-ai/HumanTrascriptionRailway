const express = require('express');
const cors = require('cors');
require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');
const supabase = require('./database');
const path = require('path');
const fs = require('fs'); // Import fs for file system operations

const authRoutes = require('./routes/authRoutes');
const audioRoutes = require('./routes/audioRoutes');
const transcriberRoutes = require('./routes/transcriberRoutes');
const generalApiRoutes = require('./routes/generalApiRoutes');
// FIX: setOnlineStatus is now in authController, not transcriberController
const { setOnlineStatus } = require('./controllers/transcriberController'); // Keep this for now, but ensure it's updated in transcriberController to only update 'users'

const app = express();
const PORT = process.env.PORT || 10000;

const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  process.env.CLIENT_URL,
].filter(Boolean);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Requested-With", "X-HTTP-Method-Override"],
    credentials: true
  },
  allowEIO3: true,
  pingInterval: 25000,
  pingTimeout: 60000,
});

io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId;
  console.log(`User connected via WebSocket: ${socket.id} (User ID: ${userId || 'N/A'})`);

  if (userId) {
    socket.userId = userId;
    // CRITICAL FIX: Automatically join the user's room upon connection if userId is provided in handshake
    socket.join(userId);
    console.log(`Socket ${socket.id} automatically joined room for user ${userId} from handshake query.`);

    // FIX: Fetch user_type and then call setOnlineStatus (which now updates only 'users' table)
    supabase.from('users').select('user_type').eq('id', userId).single()
      .then(({ data, error }) => {
        if (error) {
          console.error(`Error fetching user type for socket connection ${userId}:`, error);
          return;
        }
        // Only set online status if it's a transcriber
        if (data && data.user_type === 'transcriber') {
          setOnlineStatus(userId, true) // setOnlineStatus is now expected to update only 'users' table
            .then(() => console.log(`Transcriber ${userId} set to online on socket connect.`))
            .catch(err => console.error(`Failed to set transcriber ${userId} online on connect:`, err));
        }
      });

    // This 'joinUserRoom' listener is now redundant for initial connect, but kept for explicit calls if any
    socket.on('joinUserRoom', (roomUserId) => {
      if (roomUserId === userId) {
        socket.join(roomUserId);
        console.log(`Socket ${socket.id} joined room for user ${roomUserId} (explicit event).`);
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
      // FIX: Fetch user_type and then call setOnlineStatus (which now updates only 'users' table)
      supabase.from('users').select('user_type').eq('id', socket.userId).single()
        .then(({ data, error }) => {
          if (error) {
            console.error(`Error fetching user type for socket disconnect ${socket.userId}:`, error);
            return;
          }
          // Only set offline status if it's a transcriber
          if (data && data.user_type === 'transcriber') {
            setOnlineStatus(socket.userId, false) // setOnlineStatus is now expected to update only 'users' table
              .then(() => console.log(`Transcriber ${socket.userId} set to offline on socket disconnect.`))
              .catch(err => console.error(`Failed to set transcriber ${socket.userId} offline on disconnect:`, err));
          }
        });
    }
  });

  socket.on('error', (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
  });
});

// Configure Express app with dynamic CORS
app.use(cors({
  origin: ALLOWED_ORIGINS,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With', 'X-HTTP-Method-Override'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the 'uploads' directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
// NEW: Serve static files from the 'uploads/temp_negotiation_files' directory for temporary uploads
app.use('/uploads/temp_negotiation_files', express.static(path.join(__dirname, 'uploads', 'temp_negotiation_files')));


// Debugging middleware to log headers before routes are hit
app.use((req, res, next) => {
    console.log('--- Incoming Request Debug ---');
    console.log(`Path: ${req.path}`);
    console.log(`Method: ${req.method}`);
    console.log(`Origin Header: ${req.headers.origin}`);
    console.log(`Access-Control-Request-Method: ${req.headers['access-control-request-method']}`);
    console.log(`Access-Control-Request-Headers: ${req.headers['access-control-request-headers']}`);
    console.log('--- End Incoming Request Debug ---');

    const originalEnd = res.end;
    res.end = function (...args) {
        console.log('--- Outgoing Response Debug ---');
        console.log(`Path: ${req.path}`);
        console.log(`Method: ${req.method}`);
        console.log(`Response Status: ${res.statusCode}`);
        console.log(`Access-Control-Allow-Origin: ${res.getHeader('Access-Control-Allow-Origin')}`);
        console.log(`Access-Control-Allow-Methods: ${res.getHeader('Access-Control-Allow-Methods')}`);
        console.log(`Access-Control-Allow-Headers: ${res.getHeader('Access-Control-Allow-Headers')}`);
        console.log(`Access-Control-Allow-Credentials: ${res.getHeader('Access-Control-Allow-Credentials')}`);
        console.log('--- End Outgoing Response Debug ---');
        originalEnd.apply(res, args);
    };
    next();
});


const transcriberRouter = transcriberRoutes(io);
const generalApiRouter = generalApiRoutes(io);

// --- ROUTES ---
app.use('/api/transcriber', transcriberRouter);
app.use('/api/auth', authRoutes);
app.use('/api/audio', audioRoutes);
app.use('/api', generalApiRouter);

app.get('/test-db', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*').limit(1);
    if (error) throw error;
    res.json({ message: 'Database connected successfully!', data });
  } catch (error) {
    res.status(500).json({ message: 'Database connection failed', error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({ message: 'Human Transcription API is running!' });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log('Socket.IO is listening for connections.');
  console.log('Allowed CORS Origins:', ALLOWED_ORIGINS);
});

module.exports = { io, server, app };
