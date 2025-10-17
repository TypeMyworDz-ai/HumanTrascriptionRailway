const express = require('express');
const cors = require('cors');
require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');
const supabase = require('./database');

const authRoutes = require('./routes/authRoutes');
const audioRoutes = require('./routes/audioRoutes');
const transcriberRoutes = require('./routes/transcriberRoutes');
const generalApiRoutes = require('./routes/generalApiRoutes');
const { setOnlineStatus } = require('./controllers/transcriberController');

const app = express();
const PORT = process.env.PORT || 5000;

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
  allowEIO3: true
});

io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId;
  console.log(`User connected via WebSocket: ${socket.id} (User ID: ${userId || 'N/A'})`);

  if (userId) {
    socket.userId = userId;
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

// NEW: Explicitly set CORS headers for all responses and log them
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        console.log(`CORS: Setting Access-Control-Allow-Origin to ${origin} for request to ${req.path}`);
    } else {
        console.warn(`CORS: Request from disallowed origin ${origin} to ${req.path}`);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With, X-HTTP-Method-Override');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
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
