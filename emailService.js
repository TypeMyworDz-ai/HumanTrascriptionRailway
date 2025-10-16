// backend/emailService.js

const nodemailer = require('nodemailer');

// Configure transporter based on environment variables
const createTransporter = () => {
    // Check if production SMTP credentials are provided
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        console.log('Using Production SMTP for email service.');
        return nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587', 10), // Default to 587 if not set
            secure: process.env.SMTP_SECURE === 'true' || (parseInt(process.env.SMTP_PORT, 10) === 465), // Use TLS/SSL if secure is true or port is 465
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });
    } else {
        console.warn('Production SMTP credentials not found. Falling back to Mailtrap Sandbox.');
        // Mailtrap credentials (for development/testing)
        return nodemailer.createTransport({
            host: 'sandbox.smtp.mailtrap.io',
            port: 2525,
            secure: false,
            auth: {
                user: '2bb9f1220f44a7', // *** REPLACE with your Mailtrap Username ***
                pass: '5f05229824205f'  // *** REPLACE with your Mailtrap Password ***
            }
        });
    }
};

const transporter = createTransporter();
const FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || '"TypeMyworDz" <noreply@typemywordz.com>';


// Function to send a welcome email
const sendWelcomeEmail = async (user) => {
    try {
        await transporter.sendMail({
            from: FROM_ADDRESS, // Sender address
            to: user.email, // Receiver's email address
            subject: "Welcome to TypeMyworDz!", // Email subject
            html: `
                <h1>Welcome to TypeMyworDz!</h1>
                <p>Hello ${user.full_name || 'User'},</p>
                <p>Whether you are looking to work or hire, you are in the right place. Our goal is to make this platform the best hub for professional and dedicated transcribers that can be hired all over the world!</p>
                
                <p>Also, check out our other product, <a href="https://typemywordz.ai">https://typemywordz.ai</a>; this is a transcription AI app that converts your audios/videos in minutes. Try it out, it's free the first 30 minutes!</p>
                
                <p>Karibu!</p>
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
            from: FROM_ADDRESS,
            to: user.email,
            subject: "Your Transcriber Test Submission",
            html: `
                <h1>Your Transcriber Test Submitted</h1>
                <p>Hello ${user.full_name || 'Transcriber'},</p>
                <p>Your transcriber test has been successfully submitted and is now pending review by our team.</p>
                <p>We will notify you via email once a decision has been made.</p>
                <p>Thank you for your patience!</p>
                <p>Best regards,<br>The TypeMyworDz Team</p>
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
        subject = "Congratulations! Your TypeMyworDz Transcriber Application is Approved!";
        htmlContent = `
            <h1>Congratulations, ${user.full_name || 'Transcriber'}!</h1>
            <p>You have been approved to join our professional team of transcribers at TypeMyworDz. Our goal is to make Kenya a hub of trusted and professional transcribers.</p>
            
            <h2>What's next?</h2>
            <p>You now need to make sure that you are alert for any offers. Remember, you have to be online to receive offers from clients. Make sure to look out for your 'Go Online', 'Go Offline', 'Set Available', 'Set Busy' buttons, toggle them accordingly in order to make sure offers don't get past you.</p>
            <p>Remember to read our 'very brief' guidelines. If a client doesn't require special guidelines, you will follow them.</p>
            <p>Let's grow this platform together and make it the best hub!</p>
            
            <p>Best regards,<br>The TypeMyworDz Team</p>
        `;
    } else if (status === 'rejected') {
        subject = "Your Transcriber Test Results: Rejected";
        htmlContent = `
            <h1>Transcriber Test Update</h1>
            <p>Hello ${user.full_name || 'Transcriber'},</p>
            <p>We appreciate the effort you took to try our test. Your scores did not meet our threshold, and we won't onboard you now. We are always looking for transcribers and you are welcome to try again after a few 3 months.</p>
            <p>Thank you.</p>
            <p>Best regards,<br>The TypeMyworDz Team</p>
        `;
    } else {
        console.error(`Invalid status provided for transcriber test result email: ${status}`);
        return; // Do not send email if status is invalid
    }

    try {
        await transporter.sendMail({
            from: FROM_ADDRESS,
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
            from: FROM_ADDRESS, // Email sent to the transcriber
            to: transcriber.email,
            subject: `New Negotiation Request from ${client.full_name}`,
            html: `
                <h1>New Negotiation Request</h1>
                <p>Hello ${transcriber.full_name || 'Transcriber'},</p>
                <p>You have received a new negotiation request from <strong>${client.full_name}</strong> (${client.email}).</p>
                <p>Please check your dashboard to review the details and respond.</p>
                <p><a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/transcriber-dashboard">Go to Dashboard</a></p>
                <p>Best regards,<br>The TypeMyworDz Team</p>
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
            from: FROM_ADDRESS,
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
                <p><a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/client-dashboard">Go to Dashboard</a></p>
                <p>Best regards,<br>The TypeMyworDz Team</p>
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
            from: FROM_ADDRESS,
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
                <p>Best regards,<br>The TypeMyworDz Team</p>
            `,
        });
        console.log(`Negotiation accepted email sent to client ${client.email} and transcriber ${transcriber.email} for #${negotiation.id}`);
    } catch (error) {
        console.error(`Error sending negotiation accepted email for #${negotiation.id}:`, error);
    }
};

// NEW: Function to send payment confirmation email to client and job notification to transcriber
const sendPaymentConfirmationEmail = async (client, transcriber, negotiation, payment) => {
    try {
        const clientSubject = `Payment Confirmed for Job #${negotiation.id} - TypeMyworDz`;
        const clientHtmlContent = `
            <h1>Payment Confirmed!</h1>
            <p>Hello ${client.full_name || 'Client'},</p>
            <p>Your payment of KES ${payment.amount} for negotiation ID <strong>${negotiation.id}</strong> has been successfully processed.</p>
            <p>Your job is now active, and <strong>${transcriber.full_name}</strong> has been notified.</p>
            <p><strong>Job Details:</strong></p>
            <ul>
                <li>Negotiation ID: ${negotiation.id}</li>
                <li>Transcriber: ${transcriber.full_name} (${transcriber.email})</li>
                <li>Agreed Price: KES ${negotiation.agreed_price_kes}</li>
                <li>Deadline: ${negotiation.deadline_hours} hours</li>
            </ul>
            <p>You can track the progress of your job on your dashboard.</p>
            <p><a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/client-dashboard">Go to Dashboard</a></p>
            <p>Best regards,<br>The TypeMyworDz Team</p>
        `;

        const transcriberSubject = `New Job Hired! Negotiation #${negotiation.id} - TypeMyworDz`;
        const transcriberHtmlContent = `
            <h1>New Job Hired!</h1>
            <p>Hello ${transcriber.full_name || 'Transcriber'},</p>
            <p>A client, <strong>${client.full_name}</strong> (${client.email}), has successfully paid for negotiation ID <strong>${negotiation.id}</strong>.</p>
            <p>This job is now active. You have been marked as busy and will not receive new offers until this job is completed.</p>
            <p><strong>Job Details:</strong></p>
            <ul>
                <li>Negotiation ID: ${negotiation.id}</li>
                <li>Client: ${client.full_name} (${client.email})</li>
                <li>Agreed Price: KES ${negotiation.agreed_price_kes}</li>
                <li>Deadline: ${negotiation.deadline_hours} hours</li>
            </ul>
            <p>Please proceed with the transcription and mark the job as complete on your dashboard once finished.</p>
            <p><a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/transcriber-dashboard">Go to Dashboard</a></p>
            <p>Best regards,<br>The TypeMyworDz Team</p>
        `;

        // Send to client
        await transporter.sendMail({
            from: FROM_ADDRESS,
            to: client.email,
            subject: clientSubject,
            html: clientHtmlContent,
        });
        console.log(`Payment confirmation email sent to client ${client.email} for #${negotiation.id}`);

        // Send to transcriber
        await transporter.sendMail({
            from: FROM_ADDRESS,
            to: transcriber.email,
            subject: transcriberSubject,
            html: transcriberHtmlContent,
        });
        console.log(`New job hired email sent to transcriber ${transcriber.email} for #${negotiation.id}`);

    } catch (error) {
        console.error(`Error sending payment confirmation/job hired email for #${negotiation.id}:`, error);
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
        ${reason ? `
            <p><strong>Reason:</strong> ${reason}</p>
            <p>We recommend reviewing the project details or contacting support if you have questions.</p>
        ` : '<p>Please review the details or contact support if you have questions.</p>'}
        <p>Best regards,<br>The TypeMyworDz Team</p>
    `;

    try {
        await transporter.sendMail({
            from: FROM_ADDRESS,
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
    sendTranscriberTestResultEmail, // Correctly exported
    sendNewNegotiationRequestEmail,
    sendCounterOfferEmail,
    sendNegotiationAcceptedEmail,
    sendPaymentConfirmationEmail, // NEW: Export payment confirmation email
    sendNegotiationRejectedEmail,
};
