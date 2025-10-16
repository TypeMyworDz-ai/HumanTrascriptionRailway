// backend/emailService.js

const nodemailer = require('nodemailer');

// Mailtrap credentials (REPLACE WITH YOUR ACTUAL CREDENTIALS)
const mailtrapCredentials = {
    host: 'sandbox.smtp.mailtrap.io',     // *** REPLACE with your Mailtrap Host ***
    port: 2525,                           // *** REPLACE with your Mailtrap Port (e.g., 2525) ***
    secure: false,                        // Use 'true' if port is 465, false otherwise (for 2525, 587 it's false)
    auth: {
        user: '2bb9f1220f44a7',            // *** REPLACE with your Mailtrap Username ***
        pass: '5f05229824205f'             // *** REPLACE with your Mailtrap Password ***
    }
};

// Create a Nodemailer transporter using the Mailtrap credentials
const transporter = nodemailer.createTransport(mailtrapCredentials);

// Function to send a welcome email
const sendWelcomeEmail = async (user) => {
    try {
        await transporter.sendMail({
            from: '"TypeMyworDz" <noreply@typemywordz.com>', // Sender address (can be anything for Mailtrap)
            to: user.email, // Receiver's email address
            subject: "Welcome to TypeMyworDz!", // Email subject
            html: `
                <h1>Welcome, ${user.full_name || 'User'}!</h1>
                <p>Thank you for joining us. We're excited to have you!</p>
                
                
                <p>Best regards,<br>The TypeMyworDz Team</p>
            `,
        });
        console.log(`Welcome email sent successfully to ${user.email}`);
    } catch (error) {
        console.error(`Error sending welcome email to ${user.email}:`, error);
    }
};

// Function to send transcriber test submission email
const sendTranscriberTestSubmittedEmail = async (user) => {
    try {
        await transporter.sendMail({
            from: '"Your App Name" <noreply@typemywordz.com>',
            to: user.email,
            subject: "Your Transcriber Test Submission",
            html: `
                <h1>Your Transcriber Test Submitted</h1>
                <p>Hello ${user.full_name || 'Transcriber'},</p>
                <p>Your transcriber test has been successfully submitted and is now pending review by our team.</p>
                <p>We will notify you via email once a decision has been made.</p>
                <p>Thank you for your patience!</p>
                <p>Best regards,<br>The Your App Team</p>
            `,
        });
        console.log(`Transcriber test submission email sent to ${user.email}`);
    } catch (error) {
        console.error(`Error sending transcriber test submission email to ${user.email}:`, error);
    }
};

// Function to send transcriber test result email (approval/rejection)
const sendTranscriberTestResultEmail = async (user, status, reason = null) => {
    let subject, htmlContent;

    if (status === 'approved') {
        subject = "Your Transcriber Test Results: Approved!";
        htmlContent = `
            <h1>Congratulations, ${user.full_name || 'Transcriber'}!</h1>
            <p>We're happy to inform you that your transcriber test has been reviewed and <strong>approved</strong>.</p>
            <p>You can now proceed with setting up your profile and start taking on jobs!</p>
            <p>Best regards,<br>The Your App Team</p>
        `;
    } else if (status === 'rejected') {
        subject = "Your Transcriber Test Results: Rejected";
        htmlContent = `
            <h1>Transcriber Test Update</h1>
            <p>Hello ${user.full_name || 'Transcriber'},</p>
            <p>Your transcriber test has been reviewed, and unfortunately, it has been <strong>rejected</strong> at this time.</p>
            ${reason ? `<p><strong>Reason for rejection:</strong> ${reason}</p>` : ''}
            <p>We encourage you to review the requirements and try again if you wish.</p>
            <p>Best regards,<br>The Your App Team</p>
        `;
    } else {
        console.error(`Invalid status provided for transcriber test result email: ${status}`);
        return; // Do not send email if status is invalid
    }

    try {
        await transporter.sendMail({
            from: '"Your App Name" <noreply@typemywordz.com>',
            to: user.email,
            subject: subject,
            html: htmlContent,
        });
        console.log(`Transcriber test result email (${status}) sent to ${user.email}`);
    } catch (error) {
        console.error(`Error sending transcriber test result email (${status}) to ${user.email}:`, error);
    }
};

// Function to send new negotiation request email
const sendNewNegotiationRequestEmail = async (transcriber, client) => {
    try {
        await transporter.sendMail({
            from: '"Your App Name" <noreply@typemywordz.com>',
            to: transcriber.email, // Email sent to the transcriber
            subject: `New Negotiation Request from ${client.full_name}`,
            html: `
                <h1>New Negotiation Request</h1>
                <p>Hello ${transcriber.full_name || 'Transcriber'},</p>
                <p>You have received a new negotiation request from <strong>${client.full_name}</strong> (${client.email}).</p>
                <p>Please check your dashboard to review the details and respond.</p>
                <p><a href="YOUR_APP_URL/transcriber-dashboard">Go to Dashboard</a></p>
                <p>Best regards,<br>The Your App Team</p>
            `,
        });
        console.log(`New negotiation request email sent to ${transcriber.email} for client ${client.full_name}`);
    } catch (error) {
        console.error(`Error sending new negotiation request email to ${transcriber.email}:`, error);
    }
};

// Function to send counter offer email
const sendCounterOfferEmail = async (client, transcriber, negotiation) => {
    try {
        await transporter.sendMail({
            from: '"Your App Name" <noreply@typemywordz.com>',
            to: client.email, // Email sent to the client
            subject: `Counter Offer Received for Negotiation #${negotiation.id}`,
            html: `
                <h1>Counter Offer Received</h1>
                <p>Hello ${client.full_name || 'Client'},</p>
                <p>You have received a counter offer from <strong>${transcriber.full_name}</strong> for negotiation #${negotiation.id}.</p>
                <p><strong>Details:</strong></p>
                <ul>
                    <li>Proposed Price: KES ${negotiation.agreed_price_kes}</li>
                    <li>Proposed Deadline: ${negotiation.deadline_hours} hours</li>
                    ${negotiation.transcriber_response ? `<li>Transcriber's Message: ${negotiation.transcriber_response}</li>` : ''}
                </ul>
                <p>Please review the counter offer on your dashboard.</p>
                <p><a href="YOUR_APP_URL/client-dashboard">Go to Dashboard</a></p>
                <p>Best regards,<br>The Your App Team</p>
            `,
        });
        console.log(`Counter offer email sent to ${client.email} for negotiation #${negotiation.id}`);
    } catch (error) {
        console.error(`Error sending counter offer email to ${client.email} for negotiation #${negotiation.id}:`, error);
    }
};

// Function to send negotiation accepted email
const sendNegotiationAcceptedEmail = async (client, transcriber, negotiation) => {
    try {
        await transporter.sendMail({
            from: '"Your App Name" <noreply@typemywordz.com>',
            to: `${client.email}, ${transcriber.email}`, // Send to both client and transcriber
            subject: `Negotiation #${negotiation.id} Accepted!`,
            html: `
                <h1>Negotiation Accepted!</h1>
                <p>Hello,</p>
                <p>The negotiation request (ID: <strong>${negotiation.id}</strong>) has been accepted!</p>
                <p>Client: <strong>${client.full_name}</strong> (${client.email})</p>
                <p>Transcriber: <strong>${transcriber.full_name}</strong> (${transcriber.email})</p>
                <p>Job Details:</p>
                <ul>
                    <li>Agreed Price: KES ${negotiation.agreed_price_kes}</li>
                    <li>Deadline: ${negotiation.deadline_hours} hours</li>
                </ul>
                <p>You can view the job details on your respective dashboards.</p>
                <p>Best regards,<br>The Your App Team</p>
            `,
        });
        console.log(`Negotiation accepted email sent to client ${client.email} and transcriber ${transcriber.email} for #${negotiation.id}`);
    } catch (error) {
        console.error(`Error sending negotiation accepted email for #${negotiation.id}:`, error);
    }
};

// Function to send negotiation rejected email
const sendNegotiationRejectedEmail = async (user, negotiation, reason) => {
    const recipientName = user.full_name || 'User';
    const recipientEmail = user.email;
    const subject = `Negotiation #${negotiation.id} Rejected`;
    const htmlContent = `
        <h1>Negotiation Rejected</h1>
        <p>Hello ${recipientName},</p>
        <p>Your negotiation request (ID: <strong>${negotiation.id}</strong>) has been rejected.</p>
        ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
        <p>Please review the details or contact support if you have questions.</p>
        <p>Best regards,<br>The Your App Team</p>
    `;

    try {
        await transporter.sendMail({
            from: '"Your App Name" <noreply@typemywordz.com>',
            to: recipientEmail,
            subject: subject,
            html: htmlContent,
        });
        console.log(`Negotiation rejected email sent to ${recipientEmail} for #${negotiation.id}`);
    } catch (error) {
        console.error(`Error sending negotiation rejected email to ${recipientEmail} for #${negotiation.id}:`, error);
    }
};


module.exports = {
    sendWelcomeEmail,
    sendTranscriberTestSubmittedEmail,
    sendTranscriberTestResultEmail,
    sendNewNegotiationRequestEmail,
    sendCounterOfferEmail,
    sendNegotiationAcceptedEmail,
    sendNegotiationRejectedEmail,
};
