// backend/emailService.js - UPDATED for styled emails with logo, removed promotional line, and added new email types

const nodemailer = require('nodemailer');

// Configure transporter based on environment variables
const createTransporter = () => {
    // Common Nodemailer options for all transporters
    const commonOptions = {
        connectionTimeout: 15000, // milliseconds
        socketTimeout: 10000 // milliseconds
    };

    // --- Prioritize Generic Production SMTP (now Mailtrap Transactional) ---
    // We'll use the generic SMTP_HOST, SMTP_USER, SMTP_PASS for Mailtrap Transactional
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        console.log('Using Mailtrap Transactional SMTP for email service.');
        // For Mailtrap's transactional on port 587, secure: false is the correct setting
        // as it initiates STARTTLS.
        const isSecure = false; // Explicitly set to false for Mailtrap 587/STARTTLS
        
        const transporterOptions = {
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587', 10),
            secure: isSecure,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            },
            ...commonOptions
        };

        return nodemailer.createTransport(transporterOptions);
    } 
    // --- Fallback to Mailtrap Sandbox (for local development/testing) ---
    else {
        console.warn('Production SMTP credentials not found. Falling back to Mailtrap Sandbox.');
        return nodemailer.createTransport({
            host: 'sandbox.smtp.mailtrap.io',
            port: 2525,
            secure: false, 
            auth: {
                user: '2bb9f1220f44a7', // *** REPLACE with your Mailtrap Username ***
                pass: '5f05229824205f'  // *** REPLACE with your Mailtrap Password ***
            },
            ...commonOptions
        });
    }
};

const transporter = createTransporter();
const FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || '"TypeMyworDz" <noreply@typemywordz.com>';

// Your logo URL
const LOGO_URL = 'https://image2url.com/images/1760734941303-99876dfe-4695-4c96-82f1-916e6ad4fee5.png';

// Function to send a welcome email
const sendWelcomeEmail = async (user) => {
    try {
        await transporter.sendMail({
            from: FROM_ADDRESS,
            to: user.email,
            subject: "Welcome to TypeMyworDz!",
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px; background-color: #f9f9f9;">
                    <div style="text-align: center; margin-bottom: 20px;">
                        <img src="${LOGO_URL}" alt="TypeMyworDz Logo" style="max-width: 150px; height: auto; display: block; margin: 0 auto;">
                        <h1 style="color: #6a0dad; margin-top: 15px;">Welcome to TypeMyworDz!</h1>
                    </div>
                    <p style="font-size: 16px;">Hello ${user.full_name || 'User'},</p>
                    <p style="font-size: 16px;">Whether you are looking to work or hire, you are in the right place. Our goal is to make this platform the best hub for professional and dedicated transcribers that can be hired all over the world!</p>
                    
                    
                    <p style="font-size: 16px; font-weight: bold; color: #6a0dad;">Karibu!</p>
                    <p style="font-size: 14px; color: #666;">Best regards,<br>The TypeMyworDz Team</p>
                    <div style="text-align: center; margin-top: 30px; padding-top: 15px; border-top: 1px solid #eee; font-size: 12px; color: #999;">
                        &copy; ${new Date().getFullYear()} TypeMyworDz. All rights reserved.
                    </div>
                </div>
            `,
        });
        console.log(`Welcome email sent successfully to ${user.email}`);
    } catch (error) {
        console.error(`Error sending welcome email to ${user.email}:`, error);
    }
};

const sendTranscriberTestSubmittedEmail = async (user) => {
    try {
        await transporter.sendMail({
            from: FROM_ADDRESS,
            to: user.email,
            subject: "Your Transcriber Test Submission",
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px; background-color: #f9f9f9;">
                    <div style="text-align: center; margin-bottom: 20px;">
                        <img src="${LOGO_URL}" alt="TypeMyworDz Logo" style="max-width: 150px; height: auto; display: block; margin: 0 auto;">
                        <h1 style="color: #6a0dad; margin-top: 15px;">Your Transcriber Test Submitted</h1>
                    </div>
                    <p style="font-size: 16px;">Hello ${user.full_name || 'Transcriber'},</p>
                    <p style="font-size: 16px;">Your transcriber test has been successfully submitted and is now pending review by our team.</p>
                    <p style="font-size: 16px;">We will notify you via email once a decision has been made.</p>
                    <p style="font-size: 16px; font-weight: bold; color: #6a0dad;">Thank you for your patience!</p>
                    <p style="font-size: 14px; color: #666;">Best regards,<br>The TypeMyworDz Team</p>
                    <div style="text-align: center; margin-top: 30px; padding-top: 15px; border-top: 1px solid #eee; font-size: 12px; color: #999;">
                        &copy; ${new Date().getFullYear()} TypeMyworDz. All rights reserved.
                    </div>
                </div>
            `,
        });
        console.log(`Transcriber test submission email sent to ${user.email}`);
    } catch (error) {
        console.error(`Error sending transcriber test submission email to ${user.email}:`, error);
    }
};

const sendTranscriberTestResultEmail = async (user, status, reason = null) => {
    let subject, htmlContent;

    const emailHeader = `<div style="text-align: center; margin-bottom: 20px;">
                            <img src="${LOGO_URL}" alt="TypeMyworDz Logo" style="max-width: 150px; height: auto; display: block; margin: 0 auto;">
                            <h1 style="color: #6a0dad; margin-top: 15px;">`;
    const emailFooter = `</div>
                        <p style="font-size: 14px; color: #666;">Best regards,<br>The TypeMyworDz Team</p>
                        <div style="text-align: center; margin-top: 30px; padding-top: 15px; border-top: 1px solid #eee; font-size: 12px; color: #999;">
                            &copy; ${new Date().getFullYear()} TypeMyworDz. All rights reserved.
                        </div>
                    </div>`;

    if (status === 'approved') {
        subject = "Congratulations! Your TypeMyworDz Transcriber Application is Approved!";
        htmlContent = `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px; background-color: #f9f9f9;">
                ${emailHeader}Congratulations, ${user.full_name || 'Transcriber'}!</h1>
                </div>
                <p style="font-size: 16px;">You have successfully passed our transcriber test! We are very impressed with your skills.</p>
                <p style="font-size: 16px;">However, we are currently at full capacity for new transcribers. Your profile has been added to our waiting list.</p>
                <p style="font-size: 16px;">We will notify you via email as soon as new positions become available. Thank you for your understanding and patience.</p>
                <p style="font-size: 16px; font-weight: bold; color: #6a0dad;">We look forward to potentially working with you!</p>
                ${emailFooter}
            </div>
        `;
    } else if (status === 'rejected') {
        subject = "Your Transcriber Test Results: Rejected";
        htmlContent = `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px; background-color: #f9f9f9;">
                ${emailHeader}Transcriber Test Update</h1>
                </div>
                <p style="font-size: 16px;">Hello ${user.full_name || 'Transcriber'},</p>
                <p style="font-size: 16px;">We appreciate the effort you took to try our test. Your scores did not meet our threshold, and we won't onboard you now. We are always looking for transcribers and you are welcome to try again after a few 3 months.</p>
                <p style="font-size: 16px; font-weight: bold; color: #6a0dad;">Thank you.</p>
                ${emailFooter}
            </div>
        `;
    } else {
        console.error(`Invalid status provided for transcriber test result email: ${status}`);
        return;
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

const sendNewNegotiationRequestEmail = async (transcriber, client) => {
    try {
        await transporter.sendMail({
            from: FROM_ADDRESS,
            to: transcriber.email,
            subject: `New Negotiation Request from ${client.full_name || 'Client'}`,
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px; background-color: #f9f9f9;">
                    <div style="text-align: center; margin-bottom: 20px;">
                        <img src="${LOGO_URL}" alt="TypeMyworDz Logo" style="max-width: 150px; height: auto; display: block; margin: 0 auto;">
                        <h1 style="color: #6a0dad; margin-top: 15px;">New Negotiation Request</h1>
                    </div>
                    <p style="font-size: 16px;">Hello ${transcriber.full_name || 'Transcriber'},</p>
                    <p style="font-size: 16px;">You have received a new negotiation request from <strong>${client.full_name || 'Client'}</strong> (${client.email}).</p>
                    <p style="font-size: 16px;">Please check your dashboard to review the details and respond.</p>
                    <p style="font-size: 16px;"><a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/transcriber-dashboard" style="color: #6a0dad; text-decoration: none; font-weight: bold;">Go to Dashboard</a></p>
                    <p style="font-size: 14px; color: #666;">Best regards,<br>The TypeMyworDz Team</p>
                    <div style="text-align: center; margin-top: 30px; padding-top: 15px; border-top: 1px solid #eee; font-size: 12px; color: #999;">
                        &copy; ${new Date().getFullYear()} TypeMyworDz. All rights reserved.
                    </div>
                </div>
            `,
        });
        console.log(`New negotiation request email sent to ${transcriber.email} for client ${client.full_name || 'Client'}`);
    } catch (error) {
        console.error(`Error sending new negotiation request email to ${transcriber.email} for client ${client.full_name || 'Client'}:`, error);
    }
};

// REMOVED: Old sendCounterOfferEmail
// const sendCounterOfferEmail = async (client, transcriber, negotiation) => { /* ... */ };

// NEW: sendTranscriberCounterOfferEmail (Transcriber to Client)
const sendTranscriberCounterOfferEmail = async (client, transcriber, negotiation) => {
    try {
        await transporter.sendMail({
            from: FROM_ADDRESS,
            to: client.email,
            subject: `Counter Offer Received for Negotiation #${negotiation.id}`,
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px; background-color: #f9f9f9;">
                    <div style="text-align: center; margin-bottom: 20px;">
                        <img src="${LOGO_URL}" alt="TypeMyworDz Logo" style="max-width: 150px; height: auto; display: block; margin: 0 auto;">
                        <h1 style="color: #6a0dad; margin-top: 15px;">Counter Offer Received</h1>
                    </div>
                    <p style="font-size: 16px;">Hello ${client.full_name || 'Client'},</p>
                    <p style="font-size: 16px;">You have received a counter offer from <strong>${transcriber.full_name || 'Transcriber'}</strong> for negotiation #${negotiation.id}.</p>
                    <p style="font-size: 16px;"><strong>Details:</strong></p>
                    <ul style="font-size: 16px;">
                        <li>Proposed Price: USD ${negotiation.agreed_price_usd ? negotiation.agreed_price_usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'undefined'}</li>
                        <li>Proposed Deadline: ${negotiation.deadline_hours} hours</li>
                        ${negotiation.transcriber_response ? `<li>Transcriber's Message: ${negotiation.transcriber_response}</li>` : ''}
                    </ul>
                    <p style="font-size: 16px;">Please review the counter offer on your dashboard.</p>
                    <p style="font-size: 16px;"><a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/client-dashboard" style="color: #6a0dad; text-decoration: none; font-weight: bold;">Go to Dashboard</a></p>
                    <p style="font-size: 14px; color: #666;">Best regards,<br>The TypeMyworDz Team</p>
                    <div style="text-align: center; margin-top: 30px; padding-top: 15px; border-top: 1px solid #eee; font-size: 12px; color: #999;">
                        &copy; ${new Date().getFullYear()} TypeMyworDz. All rights reserved.
                    </div>
                </div>
            `,
        });
        console.log(`Transcriber counter offer email sent to client ${client.email} for negotiation #${negotiation.id}`);
    } catch (error) {
        console.error(`Error sending transcriber counter offer email to client ${client.email} for negotiation #${negotiation.id}:`, error);
    }
};

// NEW: sendClientCounterBackEmail (Client to Transcriber)
const sendClientCounterBackEmail = async (transcriber, client, negotiation) => {
    try {
        await transporter.sendMail({
            from: FROM_ADDRESS,
            to: transcriber.email,
            subject: `Client Counter Offer for Negotiation #${negotiation.id}`,
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px; background-color: #f9f9f9;">
                    <div style="text-align: center; margin-bottom: 20px;">
                        <img src="${LOGO_URL}" alt="TypeMyworDz Logo" style="max-width: 150px; height: auto; display: block; margin: 0 auto;">
                        <h1 style="color: #6a0dad; margin-top: 15px;">Client Counter Offer</h1>
                    </div>
                    <p style="font-size: 16px;">Hello ${transcriber.full_name || 'Transcriber'},</p>
                    <p style="font-size: 16px;">Client <strong>${client.full_name || 'Client'}</strong> (${client.email}) has sent a counter offer for negotiation #${negotiation.id}.</p>
                    <p style="font-size: 16px;"><strong>Details:</strong></p>
                    <ul style="font-size: 16px;">
                        <li>Proposed Price: USD ${negotiation.agreed_price_usd ? negotiation.agreed_price_usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'undefined'}</li>
                        <li>Proposed Deadline: ${negotiation.deadline_hours} hours</li>
                        ${negotiation.client_message ? `<li>Client's Message: ${negotiation.client_message}</li>` : ''}
                    </ul>
                    <p style="font-size: 16px;">Please review the counter offer on your dashboard.</p>
                    <p style="font-size: 16px;"><a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/transcriber-dashboard" style="color: #6a0dad; text-decoration: none; font-weight: bold;">Go to Dashboard</a></p>
                    <p style="font-size: 14px; color: #666;">Best regards,<br>The TypeMyworDz Team</p>
                    <div style="text-align: center; margin-top: 30px; padding-top: 15px; border-top: 1px solid #eee; font-size: 12px; color: #999;">
                        &copy; ${new Date().getFullYear()} TypeMyworDz. All rights reserved.
                    </div>
                </div>
            `,
        });
        console.log(`Client counter offer email sent to transcriber ${transcriber.email} for negotiation #${negotiation.id}`);
    } catch (error) {
        console.error(`Error sending client counter offer email to transcriber ${transcriber.email} for negotiation #${negotiation.id}:`, error);
    }
};

const sendNegotiationAcceptedEmail = async (client, transcriber, negotiation) => {
    try {
        await transporter.sendMail({
            from: FROM_ADDRESS,
            to: `${client.email}, ${transcriber.email}`,
            subject: `Negotiation #${negotiation.id} Accepted!`,
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px; background-color: #f9f9f9;">
                    <div style="text-align: center; margin-bottom: 20px;">
                        <img src="${LOGO_URL}" alt="TypeMyworDz Logo" style="max-width: 150px; height: auto; display: block; margin: 0 auto;">
                        <h1 style="color: #6a0dad; margin-top: 15px;">Negotiation Accepted!</h1>
                    </div>
                    <p style="font-size: 16px;">Hello,</p>
                    <p style="font-size: 16px;">The negotiation request (ID: <strong>${negotiation.id}</strong>) has been accepted!</p>
                    <p style="font-size: 16px;">Client: <strong>${client.full_name || 'Client'}</strong> (${client.email})</p>
                    <p style="font-size: 16px;">Transcriber: <strong>${transcriber.full_name || 'Transcriber'}</strong> (${transcriber.email})</p>
                    <p style="font-size: 16px;"><strong>Job Details:</strong></p>
                    <ul style="font-size: 16px;">
                        <li>Agreed Price: USD ${negotiation.agreed_price_usd ? negotiation.agreed_price_usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'undefined'}</li>
                        <li>Deadline: ${negotiation.deadline_hours} hours</li>
                    </ul>
                    <p style="font-size: 16px;">You can view the job details on your respective dashboards.</p>
                    <p style="font-size: 14px; color: #666;">Best regards,<br>The TypeMyworDz Team</p>
                    <div style="text-align: center; margin-top: 30px; padding-top: 15px; border-top: 1px solid #eee; font-size: 12px; color: #999;">
                        &copy; ${new Date().getFullYear()} TypeMyworDz. All rights reserved.
                    </div>
                </div>
            `,
        });
        console.log(`Negotiation accepted email sent to client ${client.email} and transcriber ${transcriber.email} for #${negotiation.id}`);
    } catch (error) {
        console.error(`Error sending negotiation accepted email for #${negotiation.id}:`, error);
    }
};

const sendPaymentConfirmationEmail = async (client, transcriber, negotiation, payment) => {
    try {
        const clientSubject = `Payment Confirmed for Job #${negotiation.id} - TypeMyworDz`;
        const clientHtmlContent = `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px; background-color: #f9f9f9;">
                <div style="text-align: center; margin-bottom: 20px;">
                    <img src="${LOGO_URL}" alt="TypeMyworDz Logo" style="max-width: 150px; height: auto; display: block; margin: 0 auto;">
                    <h1 style="color: #6a0dad; margin-top: 15px;">Payment Confirmed!</h1>
                </div>
                <p style="font-size: 16px;">Hello ${client.full_name || 'Client'},</p>
                <p style="font-size: 16px;">Your payment of USD ${payment.amount ? payment.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'undefined'} for negotiation ID <strong>${negotiation.id}</strong> has been successfully processed.</p>
                <p style="font-size: 16px;">Your job is now active, and <strong>${transcriber.full_name || 'Transcriber'}</strong> has been notified.</p>
                <p style="font-size: 16px;"><strong>Job Details:</strong></p>
                <ul style="font-size: 16px;">
                    <li>Negotiation ID: ${negotiation.id}</li>
                    <li>Transcriber: ${transcriber.full_name || 'Transcriber'} (${transcriber.email})</li>
                    <li>Agreed Price: USD ${negotiation.agreed_price_usd ? negotiation.agreed_price_usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'undefined'}</li>
                    <li>Deadline: ${negotiation.deadline_hours} hours</li>
                </ul>
                <p style="font-size: 16px;">You can track the progress of your job on your dashboard.</p>
                <p style="font-size: 16px;"><a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/client-dashboard" style="color: #6a0dad; text-decoration: none; font-weight: bold;">Go to Dashboard</a></p>
                <p style="font-size: 14px; color: #666;">Best regards,<br>The TypeMyworDz Team</p>
                <div style="text-align: center; margin-top: 30px; padding-top: 15px; border-top: 1px solid #eee; font-size: 12px; color: #999;">
                    &copy; ${new Date().getFullYear()} TypeMyworDz. All rights reserved.
                </div>
            </div>
        `;

        const transcriberSubject = `New Job Hired! Negotiation #${negotiation.id} - TypeMyworDz`;
        const transcriberHtmlContent = `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px; background-color: #f9f9f9;">
                <div style="text-align: center; margin-bottom: 20px;">
                    <img src="${LOGO_URL}" alt="TypeMyworDz Logo" style="max-width: 150px; height: auto; display: block; margin: 0 auto;">
                    <h1 style="color: #6a0dad; margin-top: 15px;">New Job Hired!</h1>
                </div>
                <p style="font-size: 16px;">Hello ${transcriber.full_name || 'Transcriber'},</p>
                <p style="font-size: 16px;">A client, <strong>${client.full_name || 'Client'}</strong> (${client.email}), has successfully paid for negotiation ID <strong>${negotiation.id}</strong>.</p>
                <p style="font-size: 16px;">This job is now active. You have been marked as busy and will not receive new offers until this job is completed.</p>
                <p style="font-size: 16px;"><strong>Job Details:</strong></p>
                <ul style="font-size: 16px;">
                    <li>Negotiation ID: ${negotiation.id}</li>
                    <li>Client: ${client.full_name || 'Client'} (${client.email})</li>
                    <li>Agreed Price: USD ${negotiation.agreed_price_usd ? negotiation.agreed_price_usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'undefined'}</li>
                    <li>Deadline: ${negotiation.deadline_hours} hours</li>
                </ul>
                <p style="font-size: 16px;">Please proceed with the transcription and mark the job as complete on your dashboard once finished.</p>
                <p style="font-size: 16px;"><a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/transcriber-dashboard" style="color: #6a0dad; text-decoration: none; font-weight: bold;">Go to Dashboard</a></p>
                <p style="font-size: 14px; color: #666;">Best regards,<br>The TypeMyworDz Team</p>
                <div style="text-align: center; margin-top: 30px; padding-top: 15px; border-top: 1px solid #eee; font-size: 12px; color: #999;">
                    &copy; ${new Date().getFullYear()} TypeMyworDz. All rights reserved.
                </div>
            </div>
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

const sendNegotiationRejectedEmail = async (user, negotiation, reason) => {
    const recipientName = user.full_name || 'User';
    const recipientEmail = user.email;
    const subject = `Negotiation #${negotiation.id} Rejected`;
    const htmlContent = `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px; background-color: #f9f9f9;">
            <div style="text-align: center; margin-bottom: 20px;">
                <img src="${LOGO_URL}" alt="TypeMyworDz Logo" style="max-width: 150px; height: auto; display: block; margin: 0 auto;">
                <h1 style="color: #6a0dad; margin-top: 15px;">Negotiation Rejected</h1>
            </div>
            <p style="font-size: 16px;">Hello ${recipientName},</p>
            <p style="font-size: 16px;">Your negotiation request (ID: <strong>${negotiation.id}</strong>) has been rejected.</p>
            ${reason ? `
                <p style="font-size: 16px;"><strong>Reason:</strong> ${reason}</p>
                <p style="font-size: 16px;">We recommend reviewing the project details or contacting support if you have questions.</p>
            ` : '<p style="font-size: 16px;">Please review the details or contact support if you have questions.</p>'}
            <p style="font-size: 14px; color: #666;">Best regards,<br>The TypeMyworDz Team</p>
            <div style="text-align: center; margin-top: 30px; padding-top: 15px; border-top: 1px solid #eee; font-size: 12px; color: #999;">
                &copy; ${new Date().getFullYear()} TypeMyworDz. All rights reserved.
            </div>
        </div>
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

// NEW: Function to send email upon training completion and promotion to transcriber
const sendTrainingCompletionEmail = async (user) => {
    try {
        await transporter.sendMail({
            from: FROM_ADDRESS,
            to: user.email,
            subject: "Congratulations! You are now a TypeMyworDz Transcriber!",
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px; background-color: #f9f9f9;">
                    <div style="text-align: center; margin-bottom: 20px;">
                        <img src="${LOGO_URL}" alt="TypeMyworDz Logo" style="max-width: 150px; height: auto; display: block; margin: 0 auto;">
                        <h1 style="color: #6a0dad; margin-top: 15px;">Congratulations, ${user.full_name || 'Trainee'}!</h1>
                    </div>
                    <p style="font-size: 16px;">We are thrilled to inform you that you have successfully completed your training and have been promoted to an active transcriber!</p>
                    <p style="font-size: 16px;">You can now start receiving and accepting transcription jobs from clients. Make sure to keep your availability status updated on your dashboard.</p>
                    <p style="font-size: 16px;"><a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/transcriber-dashboard" style="color: #6a0dad; text-decoration: none; font-weight: bold;">Go to Your Transcriber Dashboard</a></p>
                    <p style="font-size: 16px; font-weight: bold; color: #6a0dad;">Welcome to the team!</p>
                    <div style="text-align: center; margin-top: 30px; padding-top: 15px; border-top: 1px solid #eee; font-size: 12px; color: #999;">
                        &copy; ${new Date().getFullYear()} TypeMyworDz. All rights reserved.
                    </div>
                </div>
            `,
        });
        console.log(`Training completion email sent to ${user.email}`);
    } catch (error) {
        console.error(`Error sending training completion email to ${user.email}:`, error);
    }
};

// NEW: Function to send email when an admin marks a transcriber payment as paid out
const sendPayoutConfirmationEmail = async (transcriber, payment) => {
    try {
        await transporter.sendMail({
            from: FROM_ADDRESS,
            to: transcriber.email,
            subject: `Payout Confirmation - USD ${payment.transcriber_earning.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} from TypeMyworDz`,
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px; background-color: #f9f9f9;">
                    <div style="text-align: center; margin-bottom: 20px;">
                        <img src="${LOGO_URL}" alt="TypeMyworDz Logo" style="max-width: 150px; height: auto; display: block; margin: 0 auto;">
                        <h1 style="color: #6a0dad; margin-top: 15px;">Your Payout Has Been Processed!</h1>
                    </div>
                    <p style="font-size: 16px;">Hello ${transcriber.full_name || 'Transcriber'},</p>
                    <p style="font-size: 16px;">We are pleased to confirm that your payout for the amount of <strong>USD ${payment.transcriber_earning.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong> has been processed.</p>
                    <p style="font-size: 16px;">This payment is for job ID: <strong>${payment.related_job_id?.substring(0, 8) || 'N/A'}...</strong>, originally paid by the client on ${new Date(payment.transaction_date).toLocaleDateString()}.</p>
                    <p style="font-size: 16px;">Please check your payment method (M-Pesa/PayPal) within 1-2 business days for the funds to reflect.</p>
                    <p style="font-size: 16px;"><a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/transcriber-payments" style="color: #6a0dad; text-decoration: none; font-weight: bold;">View Your Payment History</a></p>
                    <div style="text-align: center; margin-top: 30px; padding-top: 15px; border-top: 1px solid #eee; font-size: 12px; color: #999;">
                        &copy; ${new Date().getFullYear()} TypeMyworDz. All rights reserved.
                    </div>
                </div>
            `,
        });
        console.log(`Payout confirmation email sent to ${transcriber.email} for payment ID ${payment.id}`);
    } catch (error) {
        console.error(`Error sending payout confirmation email to ${transcriber.email} for payment ID ${payment.id}:`, error);
    }
};

// NEW: Function to send email to transcriber when a client marks a negotiation job as complete
const sendJobCompletedEmailToTranscriber = async (transcriber, client, negotiation) => {
    try {
        await transporter.sendMail({
            from: FROM_ADDRESS,
            to: transcriber.email,
            subject: `Job Completed by Client: Negotiation #${negotiation.id} - TypeMyworDz`,
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px; background-color: #f9f9f9;">
                    <div style="text-align: center; margin-bottom: 20px;">
                        <img src="${LOGO_URL}" alt="TypeMyworDz Logo" style="max-width: 150px; height: auto; display: block; margin: 0 auto;">
                        <h1 style="color: #6a0dad; margin-top: 15px;">Your Job Has Been Marked as Complete!</h1>
                    </div>
                    <p style="font-size: 16px;">Hello ${transcriber.full_name || 'Transcriber'},</p>
                    <p style="font-size: 16px;">Client <strong>${client.full_name || 'Client'}</strong> has marked negotiation job <strong>#${negotiation.id}</strong> as complete.</p>
                    <p style="font-size: 16px;">Your earnings for this job are now in 'pending' payout status and will be processed according to our payment schedule.</p>
                    <p style="font-size: 16px;">You can view your updated payment history on your dashboard.</p>
                    <p style="font-size: 16px;"><a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/transcriber-payments" style="color: #6a0dad; text-decoration: none; font-weight: bold;">View Payment History</a></p>
                    <p style="font-size: 14px; color: #666;">Best regards,<br>The TypeMyworDz Team</p>
                    <div style="text-align: center; margin-top: 30px; padding-top: 15px; border-top: 1px solid #eee; font-size: 12px; color: #999;">
                        &copy; ${new Date().getFullYear()} TypeMyworDz. All rights reserved.
                    </div>
                </div>
            `,
        });
        console.log(`Job completed email sent to transcriber ${transcriber.email} for negotiation #${negotiation.id}`);
    } catch (error) {
        console.error(`Error sending job completed email to transcriber ${transcriber.email} for negotiation #${negotiation.id}:`, error);
    }
};

// NEW: Function to send email to client as confirmation that they marked a negotiation job as complete
const sendJobCompletedEmailToClient = async (client, transcriber, negotiation) => {
    try {
        await transporter.sendMail({
            from: FROM_ADDRESS,
            to: client.email,
            subject: `Confirmation: Job Marked Complete - Negotiation #${negotiation.id} - TypeMyworDz`,
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px; background-color: #f9f9f9;">
                    <div style="text-align: center; margin-bottom: 20px;">
                        <img src="${LOGO_URL}" alt="TypeMyworDz Logo" style="max-width: 150px; height: auto; display: block; margin: 0 auto;">
                        <h1 style="color: #6a0dad; margin-top: 15px;">You Marked Your Job as Complete!</h1>
                    </div>
                    <p style="font-size: 16px;">Hello ${client.full_name || 'Client'},</p>
                    <p style="font-size: 16px;">This is a confirmation that you have successfully marked negotiation job <strong>#${negotiation.id}</strong> as complete.</p>
                    <p style="font-size: 16px;">Thank you for your feedback! The transcriber, <strong>${transcriber.full_name || 'Transcriber'}</strong>, has been notified.</p>
                    <p style="font-size: 16px;">You can review your completed jobs and transcriber feedback on your dashboard.</p>
                    <p style="font-size: 16px;"><a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/client-dashboard" style="color: #6a0dad; text-decoration: none; font-weight: bold;">View Completed Jobs</a></p>
                    <p style="font-size: 14px; color: #666;">Best regards,<br>The TypeMyworDz Team</p>
                    <div style="text-align: center; margin-top: 30px; padding-top: 15px; border-top: 1px solid #eee; font-size: 12px; color: #999;">
                        &copy; ${new Date().getFullYear()} TypeMyworDz. All rights reserved.
                    </div>
                </div>
            `,
        });
        console.log(`Job completed confirmation email sent to client ${client.email} for negotiation #${negotiation.id}`);
    } catch (error) {
        console.error(`Error sending job completed confirmation email to client ${client.email} for negotiation #${negotiation.id}:`, error);
    }
};


module.exports = {
    sendWelcomeEmail,
    sendTranscriberTestSubmittedEmail,
    sendTranscriberTestResultEmail,
    sendNewNegotiationRequestEmail,
    sendTranscriberCounterOfferEmail,
    sendClientCounterBackEmail,
    sendNegotiationAcceptedEmail,
    sendPaymentConfirmationEmail,
    sendNegotiationRejectedEmail,
    sendTrainingCompletionEmail,
    sendPayoutConfirmationEmail,
    sendJobCompletedEmailToTranscriber, // NEW: Export the new function
    sendJobCompletedEmailToClient,      // NEW: Export the new function
};
