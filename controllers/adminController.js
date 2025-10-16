// backend/controllers/adminController.js - Part 1 - UPDATED for getUserByIdForAdmin (Final Fix)

const supabase = require('..//database');
const emailService = require('..//emailService'); 
const { v4: uuidv4 } = require('uuid'); 

console.log('[authController.js] Module loaded.'); // DEBUG
console.log('[authController.js] uuidv4 imported:', typeof uuidv4); // DEBUG

const FRONTEND_URL = process.env.CLIENT_URL || 'http://localhost:3000';
console.log('[authController.js] FRONTEND_URL:', FRONTEND_URL); // DEBUG

// Register new user
const registerUser = async (req, res) => {
  console.log('[registerUser] Function called.'); // DEBUG
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

// NEW: Password Reset Request function
const requestPasswordReset = async (req, res) => {
    console.log('[requestPasswordReset] Function called.');
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required.' });
        }

        // Find the user by email
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('id, full_name, email')
            .eq('email', email)
            .single();

        if (userError) {
            console.error('[requestPasswordReset] Supabase error finding user:', userError);
            return res.status(500).json({ error: userError.message });
        }
        if (!user) {
            console.warn('[requestPasswordReset] User not found for email:', email);
            // Still return success to prevent email enumeration
            return res.json({ message: 'If a matching account is found, a password reset link has been sent to your email.' });
        }

        // Generate a unique token
        const token = uuidv4();
        const expiresAt = new Date(Date.now() + 3600000); // Token valid for 1 hour

        // Save the token to the database
        const { error: tokenError } = await supabase
            .from('password_reset_tokens')
            .insert([
                {
                    user_id: user.id,
                    token: token,
                    expires_at: expiresAt.toISOString()
                }
            ]);

        if (tokenError) {
            console.error('[requestPasswordReset] Supabase error saving reset token:', tokenError);
            throw tokenError;
        }

        // Send password reset email
        const resetLink = `${FRONTEND_URL}/reset-password?token=${token}`;
        await emailService.sendPasswordResetEmail(user, resetLink);

        console.log(`[requestPasswordReset] Password reset link sent to ${email}`);
        res.json({ message: 'If a matching account is found, a password reset link has been sent to your email.' });

    } catch (error) {
        console.error('[requestPasswordReset] Error during password reset request:', error);
        res.status(500).json({ error: error.message });
    }
};

// NEW: Password Reset function
const resetPassword = async (req, res) => {
    console.log('[resetPassword] Function called.');
    try {
        const { token, newPassword } = req.body;

        if (!token || !newPassword) {
            return res.status(400).json({ error: 'Token and new password are required.' });
        }

        // Find and validate the token
        const { data: resetToken, error: tokenError } = await supabase
            .from('password_reset_tokens')
            .select('id, user_id, expires_at')
            .eq('token', token)
            .single();

        if (tokenError) {
            console.error('[resetPassword] Supabase error finding reset token:', tokenError);
            return res.status(500).json({ error: tokenError.message });
        }
        if (!resetToken || new Date() > new Date(resetToken.expires_at)) {
            console.warn('[resetPassword] Invalid or expired token:', token);
            return res.status(400).json({ error: 'Invalid or expired password reset token.' });
        }

        // Hash the new password
        const newPasswordHash = await bcrypt.hash(newPassword, 10);

        // Update user's password
        const { error: userUpdateError } = await supabase
            .from('users')
            .update({ password_hash: newPasswordHash, updated_at: new Date().toISOString() })
            .eq('id', resetToken.user_id);

        if (userUpdateError) {
            console.error('[resetPassword] Supabase error updating user password:', userUpdateError);
            throw userUpdateError;
        }

        // Invalidate the token (delete it so it can't be reused)
        const { error: deleteTokenError } = await supabase
            .from('password_reset_tokens')
            .delete()
            .eq('id', resetToken.id);

        if (deleteTokenError) {
            console.error('[resetPassword] Supabase error deleting used reset token:', deleteTokenError);
            // Don't throw error, password was updated, but log it.
        }

        console.log(`[resetPassword] Password successfully reset for user ID: ${resetToken.user_id}`);
        res.json({ message: 'Password has been reset successfully.' });

    } catch (error) {
        console.error('[resetPassword] Error during password reset:', error);
        res.status(500).json({ error: error.message });
    }
};

module.exports = { registerUser, loginUser, getUserById };
// backend/controllers/adminController.js - Part 2 - UPDATED for getUserByIdForAdmin (Final Fix) (Continue from Part 1)

module.exports = {
    getPendingTranscriberTestsCount,
    getActiveJobsCount,
    getOpenDisputesCount,
    getTotalUsersCount,
    getAllTranscriberTestSubmissions,
    getTranscriberTestSubmissionById,
    approveTranscriberTest,
    rejectTranscriberTest,
    getAllUsersForAdmin,
    getUserByIdForAdmin, // FIXED: Ensure this is exported correctly
    getAnyUserById,
    getAdminSettings,    
    updateAdminSettings, 
    getAllJobsForAdmin,  
    getAllDisputesForAdmin, 
};
