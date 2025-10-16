// backend/controllers/authController.js - Part 1 - UPDATED with Forgot/Reset Password functionality

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('..//database');
const emailService = require('..//emailService'); 
const { v4: uuidv4 } = require('uuid'); // For generating UUIDs for reset tokens

// Define the frontend URL for password reset links.
// This will come from an environment variable (e.g., CLIENT_URL from Railway)
const FRONTEND_URL = process.env.CLIENT_URL || 'http://localhost:3000';

// Register new user
const registerUser = async (req, res) => {
  try {
    const { email, password, full_name, user_type = 'client', phone } = req.body;

    console.log('registerUser: Request body:', req.body);
    console.log('registerUser: Attempting to register user with email:', email, 'user_type:', user_type);

    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (existingUser) {
      console.warn('registerUser: User already exists for email:', email);
      return res.status(400).json({ error: 'User already exists' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    console.log('registerUser: Password hashed.');

    const { data: userData, error: userError } = await supabase
      .from('users')
      .insert([
        {
          email,
          password_hash,
          full_name,
          user_type,
          last_login: null
        }
      ])
      .select('id, email, full_name, user_type, created_at, last_login')
      .single();

    if (userError) {
        console.error('registerUser: Supabase error creating core user:', userError);
        throw userError;
    }

    const newUser = userData;
    console.log('registerUser: Core user created: ', newUser.id, newUser.email);

    // --- SENDING THE WELCOME EMAIL ---
    if (newUser && newUser.email) {
        await emailService.sendWelcomeEmail(newUser);
    }
    // --- END OF EMAIL INTEGRATION ---

    if (newUser.user_type === 'client') {
        console.log('registerUser: Creating client profile for user ID: ', newUser.id);
        const { error: clientProfileError } = await supabase
            .from('clients')
            .insert([{ id: newUser.id, phone: phone, client_rating: 5.0 }])
            .select();
        if (clientProfileError) {
            console.error('registerUser: Supabase error creating client profile: ', clientProfileError);
            throw clientProfileError;
        }
        console.log('registerUser: Client profile created for user ID: ', newUser.id);
    } else if (newUser.user_type === 'transcriber') {
        console.log('registerUser: Creating transcriber profile for user ID: ', newUser.id);
        const { error: transcriberProfileError } = await supabase
            .from('transcribers')
            .insert([{ id: newUser.id, phone: phone, status: 'pending_assessment', user_level: 'transcriber', is_online: false, is_available: true, average_rating: 0.0, completed_jobs: 0, badges: null, current_job_id: null }])
            .select();
        if (transcriberProfileError) {
            console.error('registerUser: Supabase error creating transcriber profile: ', transcriberProfileError);
            throw transcriberProfileError;
        }
        console.log('registerUser: Transcriber profile created for user ID: ', newUser.id);
    } else if (newUser.user_type === 'admin') {
        console.log('registerUser: Admin user type detected. No separate profile table created.');
    }


    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: newUser.id,
        email: newUser.email,
        full_name: newUser.full_name,
        user_type: newUser.user_type,
      }
    });

  } catch (error) {
    console.error('registerUser: Unexpected error during registration process:', error);
    res.status(500).json({ error: error.message });
  } finally {
      console.groupEnd();
  }
};

// Login user
const loginUser = async (req, res) => {
  console.groupCollapsed('Backend: loginUser triggered (START)');
  console.log('Timestamp:', new Date().toLocaleTimeString());
  console.log('Request body:', req.body);

  try {
    const { email, password } = req.body;

    console.log('loginUser: Attempting to find user with email: ', email);
    const { data: user, error: userFetchError } = await supabase
      .from('users')
      .select('id, email, full_name, user_type, password_hash, is_active, status, user_level') // Select status and user_level
      .eq('email', email)
      .single();

    if (userFetchError) {
      console.error('loginUser: Supabase error fetching user:', userFetchError);
      return res.status(500).json({ error: userFetchError.message });
    }
    if (!user) {
      console.warn('loginUser: User not found for email:', email);
      return res.status(400).json({ error: 'Invalid email or password' });
    }
    console.log('loginUser: User found: ', user.email, 'ID:', user.id, 'is_active:', user.is_active, 'user_type:', user.user_type, 'status:', user.status, 'level:', user.user_level);

    if (!user.is_active) {
      console.warn('loginUser: User account is deactivated for email:', email);
      return res.status(400).json({ error: 'Account is deactivated' });
    }

    console.log('loginUser: Comparing password for user ID: ', user.id);
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      console.warn('loginUser: Password comparison FAILED for email:', email);
      return res.status(400).json({ error: 'Invalid email or password' });
    }
    console.log('loginUser: Password comparison SUCCESS for user ID: ', user.id);


    let profileData = {};
    console.log('loginUser: User Type for profile fetching: ', user.user_type);

    if (user.user_type === 'client') {
        console.log('loginUser: Fetching client profile for user ID: ', user.id);
        const { data: clientProfile, error: clientProfileError } = await supabase
            .from('clients')
            .select('phone, client_rating')
            .eq('id', user.id)
            .single();
        if (clientProfileError) {
            console.error('loginUser: Error fetching client profile:', clientProfileError);
            return res.status(500).json({ error: clientProfileError.message });
        }
        if (!clientProfile) {
            console.error('loginUser: Client profile NOT FOUND for user ID:', user.id);
            return res.status(500).json({ error: 'Client profile not found.' });
        }
        profileData = { ...clientProfile };

        console.log('loginUser: Updating last_login for client user ID: ', user.id);
        const { error: updateError } = await supabase
            .from('users')
            .update({ last_login: new Date().toISOString() })
            .eq('id', user.id);
        if (updateError) {
            console.error('loginUser: Error updating last_login for client:', updateError);
        }

    } else if (user.user_type === 'transcriber') {
        console.log('loginUser: Fetching transcriber profile for user ID: ', user.id);
        const { data: transcriberProfile, error: transcriberProfileError } = await supabase
            .from('transcribers')
            .select('phone, status, user_level, is_online, is_available, average_rating, completed_jobs, badges, current_job_id')
            .eq('id', user.id)
            .single();
        if (transcriberProfileError) {
            console.error('loginUser: Error fetching transcriber profile:', transcriberProfileError);
            return res.status(500).json({ error: transcriberProfileError.message });
        }
        if (!transcriberProfile) {
            console.error('loginUser: Transcriber profile NOT FOUND for user ID:', user.id);
            return res.status(500).json({ error: 'Transcriber profile not found.' });
        }
        profileData = { ...transcriberProfile };

        console.log('loginUser: Updating last_login and is_online for transcriber user ID: ', user.id);
        const { error: updateError } = await supabase
            .from('users')
            .update({ last_login: new Date().toISOString() })
            .eq('id', user.id);
        if (updateError) {
            console.error('loginUser: Error updating last_login for transcriber:', updateError);
        }
        const { error: updateOnlineStatusError } = await supabase
            .from('transcribers')
            .update({ is_online: true, updated_at: new Date().toISOString() })
            .eq('id', user.id);
        if (updateOnlineStatusError) {
            console.error('loginUser: Error updating transcriber is_online status:', updateOnlineStatusError);
        }
        profileData.is_online = true;

    } else if (user.user_type === 'admin') {
        console.log('loginUser: Admin user type detected. No separate profile table for admin yet.');
    } else {
        console.error('loginUser: Unknown user type detected:', user.user_type);
        return res.status(400).json({ error: 'Unknown user type.' });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        userType: user.user_type,
        userStatus: profileData.status,
        userLevel: profileData.user_level
      },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );

    const { password_hash, ...userWithoutPasswordHash } = user;
    const fullUserObject = { ...userWithoutPasswordHash, ...profileData };
    console.log('loginUser: Login successful. Returning user object: ', fullUserObject);

    res.json({
      message: 'Login successful',
      token,
      user: fullUserObject
    });

  } catch (error) {
    console.error('loginUser: Unexpected error during login process:', error);
    res.status(500).json({ error: error.message });
  } finally {
      console.groupEnd();
  }
};

// Get user by ID
const getUserById = async (req, res) => {
  try {
    const { userId } = req.params;

    console.log('getUserById: Attempting to find user with ID:', userId);
    const { data: user, error: userFetchError } = await supabase
      .from('users')
      .select('id, full_name, email, user_type, last_login, created_at')
      .eq('id', userId)
      .single();

    if (userFetchError) {
        console.error('getUserById: Supabase error fetching core user:', userFetchError);
        return res.status(500).json({ error: userFetchError.message });
    }
    if (!user) {
        console.warn('getUserById: Core user NOT FOUND for ID:', userId);
        return res.status(404).json({ error: 'User not found' });
    }
    console.log('getUserById: Core user found:', user.full_name, 'Type:', user.user_type);


    let profileData = {};
    if (user.user_type === 'client') {
        console.log('getUserById: Fetching client profile for user ID:', user.id);
        const { data: clientProfile, error: clientProfileError } = await supabase
            .from('clients')
            .select('phone, client_rating')
            .eq('id', user.id)
            .single();
        if (clientProfileError) {
            console.error('Error fetching client profile by ID:', clientProfileError);
            return res.status(500).json({ error: clientProfileError.message });
        }
        if (!clientProfile) {
            console.error('getUserById: Client profile NOT FOUND for user ID:', user.id);
            return res.status(500).json({ error: 'Client profile not found for user.' });
        }
        profileData = { ...clientProfile };
        console.log('getUserById: Client profile found:', profileData);
    } else if (user.user_type === 'transcriber') {
        console.log('getUserById: Fetching transcriber profile for user ID:', user.id);
        const { data: transcriberProfile, error: transcriberProfileError } = await supabase
            .from('transcribers')
            .select('phone, status, user_level, is_online, is_available, average_rating, completed_jobs, badges, current_job_id')
            .eq('id', user.id)
            .single();
        if (transcriberProfileError) {
            console.error('Error fetching transcriber profile by ID:', transcriberProfileError);
            return res.status(500).json({ error: transcriberProfileError.message });
        }
        if (!transcriberProfile) {
            console.error('getUserById: Transcriber profile NOT FOUND for user ID:', user.id);
            return res.status(500).json({ error: 'Transcriber profile not found for user.' });
        }
        profileData = { ...transcriberProfile };
        console.log('getUserById: Transcriber profile found:', profileData);
    } else if (user.user_type === 'admin') {
        console.log('getUserById: Admin user detected. No separate profile table assumed.');
    }


    const fullUserObject = { ...user, ...profileData };
    console.log('getUserById: Full user object returned: ', fullUserObject);

    res.json({
      message: 'User retrieved successfully',
      user: fullUserObject
    });

  } catch (error) {
    console.error('Get user by ID error:', error);
    res.status(500).json({ error: error.message });
  } finally {
      console.groupEnd();
  }
};

module.exports = { registerUser, loginUser, getUserById };
