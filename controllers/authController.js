const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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

  // Insert core user data into the 'users' table
  const { data: userData, error: userError } = await supabase
    .from('users')
    .insert([
      {
        email,
        password_hash,
        full_name,
        user_type,
        last_login: null // Initialize last_login to null
      }
    ])
    .select('id, email, full_name, user_type, created_at, last_login') // Select necessary fields for response
    .single();

  if (userError) {
   console.error('registerUser: Supabase error creating core user:', userError);
   throw userError; // Propagate error to the catch block
  }

  const newUser = userData;
  console.log('registerUser: Core user created:', newUser.id, newUser.email);

  // --- SEND WELCOME EMAIL ---
  // Utilize emailService for sending emails, with fallback to Mailtrap if Resend isn't configured
  if (newUser && newUser.email) {
    await emailService.sendWelcomeEmail(newUser);
  }
  // --- END EMAIL INTEGRATION ---

  // Create user-specific profile data based on user_type
  if (newUser.user_type === 'client') {
   console.log('registerUser: Creating client profile for user ID:', newUser.id);
   // Initialize client profile with phone and a default average_rating of 5.0
   const { error: clientProfileError } = await supabase
     .from('clients')
     .insert([{ id: newUser.id, phone: phone, average_rating: 5.0 }]) // Use average_rating as per schema
     .select(); // No need to select if only inserting
   if (clientProfileError) {
    console.error('registerUser: Supabase error creating client profile:', clientProfileError);
    throw clientProfileError;
   }
   console.log('registerUser: Client profile created for user ID:', newUser.id);
  } else if (newUser.user_type === 'transcriber') {
   console.log('registerUser: Creating transcriber profile for user ID:', newUser.id);
   // Initialize transcriber profile with default values
   const { error: transcriberProfileError } = await supabase
     .from('transcribers')
     .insert([{ id: newUser.id, phone: phone, status: 'pending_assessment', user_level: 'transcriber', is_online: false, is_available: true, average_rating: 0.0, completed_jobs: 0, badges: null, current_job_id: null }])
     .select();
   if (transcriberProfileError) {
    console.error('registerUser: Supabase error creating transcriber profile:', transcriberProfileError);
    throw transcriberProfileError;
   }
   console.log('registerUser: Transcriber profile created for user ID:', newUser.id);
  } else if (newUser.user_type === 'admin') {
   console.log('registerUser: Admin user type detected. No separate profile table created.');
  }

  // Respond with success message and basic user information
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
  // Fetch user with necessary fields including profile-related ones and status flags
  const { data: user, error: userFetchError } = await supabase
    .from('users')
    .select('id, email, full_name, user_type, password_hash, is_active, status, user_level, is_online, is_available')
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
  console.log('loginUser: User found:', user.email, 'ID:', user.id, 'is_active:', user.is_active, 'user_type:', user.user_type, 'status:', user.status, 'level:', user.user_level, 'is_online:', user.is_online, 'is_available:', user.is_available);

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

  // Fetch additional profile data based on user type
  let profileData = {};
  console.log('loginUser: User Type for profile fetching:', user.user_type);

  if (user.user_type === 'client') {
   console.log('loginUser: Fetching client profile for user ID:', user.id);
   const { data: clientProfile, error: clientProfileError } = await supabase
     .from('clients')
     .select('phone, average_rating') // Fetch phone and average_rating
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
   // Map average_rating to client_rating for consistency if needed by frontend
   profileData = { ...clientProfile, client_rating: clientProfile.average_rating };
   delete profileData.average_rating; // Remove original average_rating if client_rating is used
   console.log('loginUser: Client profile found:', profileData);

   // Update last_login timestamp for the client
   console.log('loginUser: Updating last_login for client user ID:', user.id);
   const { error: updateError } = await supabase
     .from('users')
     .update({ last_login: new Date().toISOString() })
     .eq('id', user.id);
   if (updateError) {
    console.error('loginUser: Error updating last_login for client:', updateError);
   }

  } else if (user.user_type === 'transcriber') {
   console.log('loginUser: Fetching transcriber profile for user ID:', user.id);
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
   // Combine user status flags with transcriber profile data
   profileData = { ...transcriberProfile, is_online: user.is_online, is_available: user.is_available };
   console.log('loginUser: Transcriber profile found:', profileData);

   // Update last_login and set is_online to true for transcribers upon login
   console.log('loginUser: Updating last_login and is_online for transcriber user ID:', user.id);
   const { error: updateUserOnlineStatusError } = await supabase
     .from('users')
     .update({ last_login: new Date().toISOString(), is_online: true })
     .eq('id', user.id);
   if (updateUserOnlineStatusError) {
    console.error('loginUser: Error updating users.is_online status:', updateUserOnlineStatusError);
   }
   profileData.is_online = true; // Ensure is_online is true in the returned profile data

  } else if (user.user_type === 'admin') {
   console.log('loginUser: Admin user type detected. No separate profile table for admin yet.');
   // Admins might have specific fields in the 'users' table itself or a separate admin table not yet implemented.
   // For now, we don't fetch additional profile data.
  } else {
   console.error('loginUser: Unknown user type detected:', user.user_type);
   return res.status(400).json({ error: 'Unknown user type.' });
  }

  // Generate JWT token
  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      userType: user.user_type,
      // Include relevant profile data in the token payload for quick access on the client
      userStatus: profileData.status, // e.g., 'pending_assessment', 'active_transcriber'
      userLevel: profileData.user_level, // e.g., 'transcriber'
      isOnline: profileData.is_online,
      isAvailable: profileData.is_available,
      clientRating: profileData.client_rating // Include client rating if available
    },
   process.env.JWT_SECRET || 'your-secret-key', // Use environment variable for JWT secret
    { expiresIn: '7d' } // Token expires in 7 days
  );

  // Prepare the user object to be returned, excluding sensitive info like password_hash
  const { password_hash, ...userWithoutPasswordHash } = user;
  const fullUserObject = { ...userWithoutPasswordHash, ...profileData }; // Combine core user data with profile data
  console.log('loginUser: Login successful. Returning user object:', fullUserObject);

  // Respond with success message, token, and user object
  res.json({
    message: 'Login successful',
    token,
    user: fullUserObject
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
  // Fetch core user data
  const { data: user, error: userFetchError } = await supabase
    .from('users')
    .select('id, full_name, email, user_type, last_login, created_at, is_online, is_available')
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

  // Fetch additional profile data based on user type
  let profileData = {};
  if (user.user_type === 'client') {
   console.log('getUserById: Fetching client profile for user ID:', user.id);
   const { data: clientProfile, error: clientProfileError } = await supabase
     .from('clients')
     .select('phone, average_rating')
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
   profileData = { ...clientProfile, client_rating: clientProfile.average_rating };
   delete profileData.average_rating;
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
   profileData = { ...transcriberProfile, is_online: user.is_online, is_available: user.is_available };
   console.log('getUserById: Transcriber profile found:', profileData);
  } else if (user.user_type === 'admin') {
   console.log('getUserById: Admin user detected. No separate profile table assumed.');
  }

  // Combine core user data with profile data
  const fullUserObject = { ...user, ...profileData };
  console.log('getUserById: Full user object returned:', fullUserObject);

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

// NEW: Function for clients to update their profile (full_name, phone)
const updateClientProfile = async (req, res) => {
    const { userId } = req.params; // ID of the profile to update
    const { full_name, phone } = req.body;
    const currentUserId = req.user.userId; // User making the request (from JWT)

    // Authorization check: User must be the owner of the profile or an admin
    if (userId !== currentUserId && req.user.userType !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized to update this client profile.' });
    }

    try {
        // Prepare data for updating the 'users' table (for full_name)
        const userUpdateData = { updated_at: new Date().toISOString() };
        if (full_name !== undefined) userUpdateData.full_name = full_name;

        // Update 'users' table, ensuring it's for a client
        const { error: userError } = await supabase
            .from('users')
            .update(userUpdateData)
            .eq('id', userId)
            .eq('user_type', 'client'); // Scope update to clients only

        if (userError) throw userError;

        // Prepare data for updating the 'clients' table (for phone)
        const clientProfileUpdateData = { updated_at: new Date().toISOString() };
        if (phone !== undefined) clientProfileUpdateData.phone = phone;

        // Update 'clients' table and select relevant fields to return
        const { data: clientProfile, error: clientProfileError } = await supabase
            .from('clients')
            .update(clientProfileUpdateData)
            .eq('id', userId)
            .select('id, phone, average_rating') // Select fields to return
            .single();

        if (clientProfileError) throw clientProfileError;
        if (!clientProfile) return res.status(404).json({ error: 'Client profile not found.' });

        // Fetch the updated user record to combine with profile data
        const { data: updatedUser, error: fetchUpdatedUserError } = await supabase
            .from('users')
            .select('id, full_name, email, user_type, last_login, created_at, is_online, is_available')
            .eq('id', userId)
            .single();

        if (fetchUpdatedUserError) throw fetchUpdatedUserError;
        if (!updatedUser) return res.status(404).json({ error: 'User not found after update.' });

        // Construct the full user object to return, nesting client profile data
        const fullUserObject = {
            ...updatedUser,
            client_profile: { // Nest client profile data
                ...clientProfile,
                client_rating: clientProfile.average_rating // Keep client_rating for compatibility
            },
            // Add phone to the top level for easier frontend access if needed
            phone: clientProfile.phone
        };
        // Clean up redundant fields if necessary (e.g., if average_rating is now client_rating)
        delete fullUserObject.client_profile.average_rating;

        res.status(200).json({
            message: 'Client profile updated successfully.',
            user: fullUserObject
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
    updateClientProfile
};
