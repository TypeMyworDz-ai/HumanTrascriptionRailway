// generate_hash.js
const bcrypt = require('bcryptjs');
async function generateHash() {
    const hash = await bcrypt.hash('tmwz_2025', 10); // CRITICAL: REPLACE 'your_secret_admin_password' with the ACTUAL password you want to use for your admin.
    console.log(hash);
}
generateHash();
