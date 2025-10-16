const axios = require('axios');

const testRegistration = async () => {
  try {
    const response = await axios.post('http://localhost:5000/api/auth/register', {
      email: 'test@example.com',
      password: 'password123',
      full_name: 'Test User',
      user_type: 'client'
    });
    
    console.log('Registration successful:', response.data);
  } catch (error) {
    console.log('Registration failed:', error.response?.data || error.message);
  }
};

testRegistration();
