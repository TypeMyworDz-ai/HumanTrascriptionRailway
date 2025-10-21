const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'); // FIX: Corrected 'require' to 'jsonwebtoken'
const supabase = require('../database');
const emailService = require('../emailService');
const { v4: uuidv4 } = require('uuid'); // Import uuid for token generation

// Console logs for debugging module loading and configuration
console.log('[authController.js] Module loaded.');
console.log('[authController.js] uuidv4 imported:', typeof uuidv4);

const FRONTEND_URL = process.env.CLIENT_URL || 'http://localhost:3000';
console.log('[authController.js] FRONTEND_URL:', FRONTEND_URL);

// Register new user
const registerUser = async (req, res) => {
 console.groupCollapsed('[registerUser] Function called.'); // Use groupCollapsed for better readability in console logs
 try {
  // ADDED 'trainee' as a possible user_type
  const { email, password, full_name, user_type = 'client', phone } = req.body;

  console.log('registerUser: Request body:', req.body);
  console.log('registerUser: Attempting to register user with email:', email, 'user_type:', user_type);

  // Check if user already exists by email
  const { data: existingUser } = await supabase
    .from('users')
    .select('id')
    .eq('email', email)
    .single();

  if (existingUser) {
   console.warn('registerUser: User already exists for email:', email);
   return res.status(400).json({ error: 'User already exists' });
  }

  // Hash the password before storing
  const password_hash = await bcrypt.hash(password, 10);
  console.log('registerUser: Password hashed.');

  // Prepare initial user data for the 'users' table based on user_type
  // All profile-related fields are now initialized directly in the 'users' table
  const insertUserData = {
    email,
    password_hash,
    full_name,
    user_type,
    last_login: null,
    is_active: true, // Default to active
    is_online: false, // Default to offline
    is_available: true, // Default to available
    current_job_id: null,
    phone: phone || null, // Universal phone field

    // Initialize transcriber-specific fields (null for clients/admins/trainees)
    transcriber_status: null,
    transcriber_user_level: null,
    transcriber_average_rating: null,
    transcriber_completed_jobs: null,
    transcriber_mpesa_number: null,
    transcriber_paypal_email: null,

    // Initialize client-specific fields (null for transcribers/admins/trainees)
    client_average_rating: null,
    client_completed_jobs: null, // NEW: client_completed_jobs
    client_comment: null, // NEW: client_comment
  };

  // Set initial role-specific values for transcribers
  if (user_type === 'transcriber') {
    insertUserData.transcriber_status = 'pending_assessment';
    insertUserData.transcriber_user_level = 'transcriber';
    insertUserData.transcriber_average_rating = 0.0; // Default for new transcribers
    insertUserData.transcriber_completed_jobs = 0;
  }
  // Set initial role-specific values for clients
  if (user_type === 'client') {
    insertUserData.client_average_rating = 5.0; // Default rating for new clients
    insertUserData.client_completed_jobs = 0; // NEW: Initialize client_completed_jobs
  }
  // NEW: Set initial role-specific values for trainees
  if (user_type === 'trainee') {
      insertUserData.transcriber_status = 'pending_training_payment'; // Trainees start here
      insertUserData.transcriber_user_level = 'trainee'; // Assign a level for trainees
      insertUserData.is_available = false; // Trainees are not available for jobs
      // FIX: Explicitly set default values for NOT NULL columns for trainees
      insertUserData.transcriber_average_rating = 0.0; 
      insertUserData.transcriber_completed_jobs = 0;
  }
  // Admins will have null for all role-specific fields by default

  // Insert core user data into the 'users' table
  const { data: userData, error: userError } = await supabase
    .from('users')
    .insert([insertUserData])
    .select('*') // Select all columns for the response
    .single();

  if (userError) {
   console.error('registerUser: Supabase error creating core user:', userError);
   throw userError; // Propagate error to the catch block
  }

  const newUser = userData;
  console.log('registerUser: Core user created:', newUser.id, newUser.email, 'type:', newUser.user_type);

  // --- SEND WELCOME EMAIL ---
  if (newUser && newUser.email) {
    await emailService.sendWelcomeEmail(newUser);
  }
  // --- END EMAIL INTEGRATION ---

  // For 'clients' and 'transcribers' tables, only insert the ID as a marker
  // NEW: Do NOT create marker for 'trainee' in 'transcribers' table as they are not full transcribers yet
  if (newUser.user_type === 'client') {
    console.log('registerUser: Creating client marker profile for user ID:', newUser.id);
    const { error: clientProfileError } = await supabase
      .from('clients')
      .insert([{ id: newUser.id }]) // Only insert ID
      .select();
    if (clientProfileError) {
      console.error('registerUser: Supabase error creating client marker profile:', clientProfileError);
      throw clientProfileError;
    }
  } else if (newUser.user_type === 'transcriber') {
    console.log('registerUser: Creating transcriber marker profile for user ID:', newUser.id);
    const { error: transcriberProfileError } = await supabase
      .from('transcribers')
      .insert([{ id: newUser.id }]) // Only insert ID
      .select();
    if (transcriberProfileError) {
      console.error('registerUser: Supabase error creating transcriber marker profile:', transcriberProfileError);
      throw transcriberProfileError;
    }
  }

  // FIX: Generate JWT token for the newly registered user
  const token = jwt.sign(
    {
      userId: newUser.id,
      email: newUser.email,
      userType: newUser.user_type,
      isOnline: newUser.is_online,
      isAvailable: newUser.is_available,
      currentJobId: newUser.current_job_id,
      phone: newUser.phone,
      transcriberStatus: newUser.transcriber_status,
      transcriberUserLevel: newUser.transcriber_user_level,
      transcriberAverageRating: newUser.transcriber_average_rating,
      transcriberCompletedJobs: newUser.transcriber_completed_jobs,
      transcriberMpesaNumber: newUser.transcriber_mpesa_number,
      transcriberPaypalEmail: newUser.transcriber_paypal_email,
      clientAverageRating: newUser.client_average_rating,
      clientCompletedJobs: newUser.client_completed_jobs,
      clientComment: newUser.client_comment,
    },
    process.env.JWT_SECRET || 'your-secret-key',
    { expiresIn: '7d' }
  );

  // Prepare the user object to be returned (remove password hash)
  // FIX: Rename destructured 'password_hash' to avoid redeclaration
  const { password_hash: userPasswordHash, ...userWithoutPasswordHash } = newUser; 

  // Respond with success message, token, and the full new user object
  res.status(201).json({
    message: 'User registered successfully',
    token, // FIX: Return the token
    user: userWithoutPasswordHash
   });

 } catch (error) {
  console.error('registerUser: Unexpected error during registration process:', error);
  res.status(500).json({ error: error.message });
 } finally {
  console.groupEnd(); // End the console group for this function call
 }
};

// Login user
const loginUser = async (req, res) => {
 console.groupCollapsed('Backend: loginUser triggered (START)'); // Use groupCollapsed for better log organization
 console.log('Timestamp:', new Date().toLocaleTimeString());
 console.log('Request body:', req.body);

 try {
  const { email, password } = req.body;

  console.log('loginUser: Attempting to find user with email:', email);
  // Fetch all user data from the 'users' table (now the source of truth)
  const { data: user, error: userFetchError } = await supabase
    .from('users')
    .select('*') // Select all columns as 'users' is now the source of truth
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
  // Log user details found (ensure sensitive data like password_hash is not logged)
  // FIX: Corrected string literal concatenation for user.id to prevent syntax issues
  console.log('loginUser: User found:', user.email, 'ID:', user.id, 'is_active:', user.is_active, 'user_type:', user.user_type, 'is_online:', user.is_online, 'is_available:', user.is_available); 

  // Check if the user account is active
  if (!user.is_active) {
   console.warn('loginUser: User account is deactivated for email:', email);
   return res.status(400).json({ error: 'Account is deactivated' });
  }

  console.log('loginUser: Comparing password for user ID:', user.id);
  // Compare provided password with the hashed password
  const isPasswordValid = await bcrypt.compare(password, user.password_hash);

  if (!isPasswordValid) {
   console.warn('loginUser: Password comparison FAILED for email:', email);
   return res.status(400).json({ error: 'Invalid email or password' });
  }
  console.log('loginUser: Password comparison SUCCESS for user ID:', user.id);

  // Update last_login and set is_online to true for the user upon login
  console.log('loginUser: Updating last_login and is_online for user ID:', user.id);
  const { error: updateUserOnlineStatusError } = await supabase
    .from('users')
    .update({ last_login: new Date().toISOString(), is_online: true })
    .eq('id', user.id);
  if (updateUserOnlineStatusError) {
   console.error('loginUser: Error updating users.is_online status:', updateUserOnlineStatusError);
  }
  user.is_online = true; // Reflect the change immediately in the returned user object

  // Generate JWT token
  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      userType: user.user_type,
      // Include all relevant 'users' table fields directly in the token payload
      isOnline: user.is_online,
      isAvailable: user.is_available,
      currentJobId: user.current_job_id,
      phone: user.phone,
      // FIX: Explicitly include transcriber-specific fields in JWT payload
      transcriberStatus: user.transcriber_status,
      transcriberUserLevel: user.transcriber_user_level,
      transcriberAverageRating: user.transcriber_average_rating,
      transcriberCompletedJobs: user.transcriber_completed_jobs,
      transcriberMpesaNumber: user.transcriber_mpesa_number,
      transcriberPaypalEmail: user.transcriber_paypal_email,
      clientAverageRating: user.client_average_rating,
      clientCompletedJobs: user.client_completed_jobs, // NEW: client_completed_jobs
      clientComment: user.client_comment, // NEW: client_comment
    },
   process.env.JWT_SECRET || 'your-secret-key', // Use environment variable for JWT secret
    { expiresIn: '7d' } // Token expires in 7 days
  );

  // Prepare the user object to be returned (it's already the full user object from 'users' table)
  const { password_hash, ...userWithoutPasswordHash } = user; // Remove password_hash for security
  console.log('loginUser: Login successful. Returning user object:', userWithoutPasswordHash);

  // Respond with success message, token, and user object
  res.json({
    message: 'Login successful',
    token,
    user: userWithoutPasswordHash
  });

 } catch (error) {
  console.error('loginUser: Unexpected error during login process:', error);
  res.status(500).json({ error: error.message });
 } finally {
  console.groupEnd(); // End the console group for this function call
 }
};

// Get user by ID (publicly accessible for viewing profiles, etc.)
const getUserById = async (req, res) => {
 try {
  const { userId } = req.params;

  console.log('getUserById: Attempting to find user with ID:', userId);
  // Fetch all user data from the 'users' table (now the source of truth)
  const { data: user, error: userFetchError } = await supabase
    .from('users')
    .select('*') // Select all columns as 'users' is now the source of truth
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

  // Profile data is now directly within the 'user' object from the 'users' table
  const { password_hash, ...userWithoutPasswordHash } = user; // Remove password_hash for security

  console.log('getUserById: Full user object returned:', userWithoutPasswordHash);

  res.json({
    message: 'User retrieved successfully',
    user: userWithoutPasswordHash
  });

 } catch (error) {
  console.error('Get user by ID error:', error);
  res.status(500).json({ error: error.message });
 } finally {
  console.groupEnd();
 }
};

// NEW: Function for clients to update their profile (full_name, phone, client_average_rating, client_completed_jobs, client_comment)
const updateClientProfile = async (req, res) => {
    const { userId } = req.params; // ID of the profile to update
    const { full_name, phone, client_average_rating, client_completed_jobs, client_comment } = req.body; // NEW: Include new client fields
    const currentUserId = req.user.userId; // User making the request (from JWT)

    // Authorization check: User must be the owner of the profile or an admin
    if (userId !== currentUserId && req.user.userType !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized to update this client profile.' });
    }

    try {
        // Prepare data for updating the 'users' table (all profile fields are here now)
        const userUpdateData = { updated_at: new Date().toISOString() };
        if (full_name !== undefined) userUpdateData.full_name = full_name;
        if (phone !== undefined) userUpdateData.phone = phone;
        if (client_average_rating !== undefined) userUpdateData.client_average_rating = parseFloat(client_average_rating);
        if (client_completed_jobs !== undefined) userUpdateData.client_completed_jobs = parseInt(client_completed_jobs, 10); // NEW: Update client_completed_jobs
        if (client_comment !== undefined) userUpdateData.client_comment = client_comment; // NEW: Update client_comment


        // Update 'users' table, ensuring it's for a client
        const { data: updatedUser, error: userError } = await supabase
            .from('users')
            .update(userUpdateData)
            .eq('id', userId)
            .eq('user_type', 'client') // Scope update to clients only
            .select('*') // Select all updated columns to return the full user object
            .single();

        if (userError) throw userError;
        if (!updatedUser) return res.status(404).json({ error: 'Client user not found or not a client.' });

        // No need to update 'clients' table for profile data anymore, only for the marker.

        const { password_hash, ...userWithoutPasswordHash } = updatedUser; // Remove password_hash for security

        res.status(200).json({
            message: 'Client profile updated successfully.',
            user: userWithoutPasswordHash // Return the full updated user object
        });

    } catch (error) {
        console.error('Error updating client profile:', error);
        res.status(500).json({ error: 'Server error updating client profile.' });
    }
};


// NEW: Password Reset Request function
const requestPasswordReset = async (req, res) => {
    console.log('[requestPasswordReset] Function called.');
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required for password reset.' });
        }

        // Find the user by email to ensure the account exists
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('id, full_name, email') // Select minimal required fields
            .eq('email', email)
            .single();

        if (userError) {
            console.error('[requestPasswordReset] Supabase error finding user:', userError);
            return res.status(500).json({ error: userError.message });
        }
        if (!user) {
            console.warn('[requestPasswordReset] User not found for email:', email);
            // Return a generic success message to prevent email enumeration attacks
            return res.json({ message: 'If a matching account is found, a password reset link has been sent to your email.' });
        }

        // Generate a unique, short-lived token for password reset
        const token = uuidv4();
        const expiresAt = new Date(Date.now() + 3600000); // Token valid for 1 hour

        // Save the token to the 'password_reset_tokens' table
        const { error: tokenError } = await supabase
            .from('password_reset_tokens')
            .insert([
                {
                   user_id: user.id,
                   token: token,
                   expires_at: expiresAt.toISOString() // Store expiration time in ISO format
                }
            ]);

        if (tokenError) {
            console.error('[requestPasswordReset] Supabase error saving reset token:', tokenError);
            throw tokenError;
        }

        // Construct the password reset link for the frontend
        const resetLink = `${FRONTEND_URL}/reset-password?token=${token}`;
        // Send the password reset email using the emailService
        await emailService.sendPasswordResetEmail(user, resetLink);

        console.log(`[requestPasswordReset] Password reset link sent to ${email}`);
        // Return a generic success message
        res.json({ message: 'If a matching account is found, a password reset link has been sent to your email.' });

    } catch (error) {
        console.error('[requestPasswordReset] Error during password reset request:', error);
        res.status(500).json({ error: error.message });
    }
};

// NEW: Password Reset function (handles the actual password update)
const resetPassword = async (req, res) => {
    console.log('[resetPassword] Function called.');
    try {
        const { token, newPassword } = req.body;

        if (!token || !newPassword) {
            return res.status(400).json({ error: 'Token and new password are required.' });
        }

        // Find the reset token in the database and validate it
        const { data: resetToken, error: tokenError } = await supabase
                .from('password_reset_tokens')
                .select('id, user_id, expires_at') // Select necessary fields
                .eq('token', token)
                .single();

        if (tokenError) {
            console.error('[resetPassword] Supabase error finding reset token:', tokenError);
            return res.status(500).json({ error: tokenError.message });
        }
        // Check if token exists and has not expired
        if (!resetToken || new Date() > new Date(resetToken.expires_at)) {
            console.warn('[resetPassword] Invalid or expired token:', token);
            return res.status(400).json({ error: 'Invalid or expired password reset token. Please request a new one.' });
        }

        // Hash the new password
        const newPasswordHash = await bcrypt.hash(newPassword, 10);

        // Update the user's password hash in the 'users' table
        const { error: userUpdateError } = await supabase
            .from('users')
            .update({ password_hash: newPasswordHash, updated_at: new Date().toISOString() })
            .eq('id', resetToken.user_id);

        if (userUpdateError) {
            console.error('[resetPassword] Supabase error updating user password:', userUpdateError);
            throw userUpdateError;
        }

        // Invalidate the used token by deleting it from the database
        const { error: deleteTokenError } = await supabase
            .from('password_reset_tokens')
            .delete()
            .eq('id', resetToken.id);

        if (deleteTokenError) {
            console.error('[resetPassword] Supabase error deleting used reset token:', deleteTokenError);
            // Log the error but don't fail the request, as the password has been updated.
        }

        console.log(`[resetPassword] Password successfully reset for user ID: ${resetToken.user_id}`);
        res.json({ message: 'Password has been reset successfully. You can now log in with your new password.' });

    } catch (error) {
        console.error('[resetPassword] Error during password reset:', error);
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    registerUser,
    loginUser,
    getUserById,
    requestPasswordReset,
    resetPassword,
    updateClientProfile, // FIX: Added missing comma
};
