// src/services/emailService.js
import nodemailer from "nodemailer";
import { createError } from "../utils/errorHandler.js";

// Create transporter
const createTransporter = () => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    throw new Error(
      "Email configuration missing. Please set EMAIL_USER and EMAIL_PASS environment variables."
    );
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });
};

// Email templates
const getOTPEmailTemplate = (otp, purpose) => {
  const templates = {
    login: {
      subject: "Login OTP - Commune Apartments",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; text-align: center; margin-bottom: 30px;">
            <h1 style="margin: 0; font-size: 28px;">🏠 Commune Apartments</h1>
            <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.9;">Property Management Portal</p>
          </div>
          
          <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
            <h2 style="color: #333; margin-top: 0;">Login Verification Code</h2>
            <p style="color: #666; font-size: 16px; line-height: 1.5;">
              Hello! You've requested to log in to your Commune Apartments account. 
              Please use the verification code below to complete your login:
            </p>
            
            <div style="background: #f8f9fa; border: 2px dashed #667eea; border-radius: 8px; padding: 20px; text-align: center; margin: 25px 0;">
              <div style="font-size: 32px; font-weight: bold; color: #667eea; letter-spacing: 4px; font-family: 'Courier New', monospace;">
                ${otp}
              </div>
              <p style="margin: 10px 0 0 0; color: #888; font-size: 14px;">
                This code expires in 10 minutes
              </p>
            </div>
            
            <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 4px;">
              <p style="margin: 0; color: #856404; font-size: 14px;">
                <strong>Security Notice:</strong> Never share this code with anyone. Our team will never ask for your verification code.
              </p>
            </div>
            
            <p style="color: #666; font-size: 14px; margin-top: 25px;">
              If you didn't request this code, please ignore this email or contact our support team.
            </p>
          </div>
          
          <div style="text-align: center; margin-top: 30px; color: #888; font-size: 12px;">
            <p>© ${new Date().getFullYear()} Commune Apartments. All rights reserved.</p>
            <p>This is an automated message, please do not reply to this email.</p>
          </div>
        </div>
      `,
    },
    resend: {
      subject: "New Login OTP - Commune Apartments",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; text-align: center; margin-bottom: 30px;">
            <h1 style="margin: 0; font-size: 28px;">🏠 Commune Apartments</h1>
            <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.9;">Property Management Portal</p>
          </div>
          
          <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
            <h2 style="color: #333; margin-top: 0;">New Verification Code</h2>
            <p style="color: #666; font-size: 16px; line-height: 1.5;">
              You've requested a new verification code. Your previous code has been invalidated.
              Please use the new code below:
            </p>
            
            <div style="background: #f8f9fa; border: 2px dashed #667eea; border-radius: 8px; padding: 20px; text-align: center; margin: 25px 0;">
              <div style="font-size: 32px; font-weight: bold; color: #667eea; letter-spacing: 4px; font-family: 'Courier New', monospace;">
                ${otp}
              </div>
              <p style="margin: 10px 0 0 0; color: #888; font-size: 14px;">
                This code expires in 10 minutes
              </p>
            </div>
            
            <div style="background: #d1ecf1; border-left: 4px solid #17a2b8; padding: 15px; margin: 20px 0; border-radius: 4px;">
              <p style="margin: 0; color: #0c5460; font-size: 14px;">
                <strong>Note:</strong> This is a new verification code. Any previous codes are no longer valid.
              </p>
            </div>
          </div>
          
          <div style="text-align: center; margin-top: 30px; color: #888; font-size: 12px;">
            <p>© ${new Date().getFullYear()} Commune Apartments. All rights reserved.</p>
          </div>
        </div>
      `,
    },
  };

  return templates[purpose] || templates.login;
};

// Send OTP email
export const sendOTP = async (email, otp, purpose = "login") => {
  try {
    const transporter = createTransporter();
    const template = getOTPEmailTemplate(otp, purpose);

    const mailOptions = {
      from: {
        name: "Commune Apartments",
        address: process.env.EMAIL_USER,
      },
      to: email,
      subject: template.subject,
      html: template.html,
    };

    console.log(`📧 Sending ${purpose} OTP to ${email}`);

    const result = await transporter.sendMail(mailOptions);

    console.log(`✅ OTP email sent successfully to ${email}`);
    console.log(`📩 Message ID: ${result.messageId}`);

    return result;
  } catch (error) {
    console.error("📧 Email sending error:", error);
    throw createError(
      "EMAIL_ERROR",
      "Failed to send verification email. Please try again."
    );
  }
};

// Send welcome email
export const sendWelcomeEmail = async (
  email,
  firstName,
  tempPassword = null
) => {
  try {
    const transporter = createTransporter();

    const mailOptions = {
      from: {
        name: "Commune Apartments",
        address: process.env.EMAIL_USER,
      },
      to: email,
      subject: "Welcome to Commune Apartments!",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; text-align: center; margin-bottom: 30px;">
            <h1 style="margin: 0; font-size: 28px;">🏠 Welcome to Commune Apartments!</h1>
            <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.9;">Property Management Portal</p>
          </div>
          
          <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
            <h2 style="color: #333; margin-top: 0;">Hello ${firstName}!</h2>
            <p style="color: #666; font-size: 16px; line-height: 1.5;">
              Welcome to Commune Apartments! Your account has been successfully created.
            </p>
            
            <div style="background: #d4edda; border-left: 4px solid #28a745; padding: 15px; margin: 20px 0; border-radius: 4px;">
              <p style="margin: 0; color: #155724; font-size: 14px;">
                <strong>Account Details:</strong><br>
                Email: ${email}<br>
                ${
                  tempPassword
                    ? `Temporary Password: <code style="background: #f8f9fa; padding: 2px 4px; border-radius: 3px;">${tempPassword}</code>`
                    : "Login Method: OTP (One-Time Password)"
                }
              </p>
            </div>
            
            <p style="color: #666; font-size: 16px; line-height: 1.5;">
              You can now access your account and start using our property management services.
            </p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${
                process.env.FRONTEND_URL || "http://localhost:3000"
              }/login" 
                 style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
                Login to Your Account
              </a>
            </div>
          </div>
          
          <div style="text-align: center; margin-top: 30px; color: #888; font-size: 12px;">
            <p>© ${new Date().getFullYear()} Commune Apartments. All rights reserved.</p>
          </div>
        </div>
      `,
    };

    const result = await transporter.sendMail(mailOptions);
    console.log(`✅ Welcome email sent to ${email}`);
    return result;
  } catch (error) {
    console.error("📧 Welcome email error:", error);
    throw createError("EMAIL_ERROR", "Failed to send welcome email");
  }
};

// Send password reset email
export const sendPasswordResetEmail = async (email, resetToken) => {
  try {
    const transporter = createTransporter();
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

    const mailOptions = {
      from: {
        name: "Commune Apartments",
        address: process.env.EMAIL_USER,
      },
      to: email,
      subject: "Password Reset - Commune Apartments",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; text-align: center; margin-bottom: 30px;">
            <h1 style="margin: 0; font-size: 28px;">🔒 Password Reset</h1>
            <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.9;">Commune Apartments</p>
          </div>
          
          <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
            <h2 style="color: #333; margin-top: 0;">Reset Your Password</h2>
            <p style="color: #666; font-size: 16px; line-height: 1.5;">
              You've requested to reset your password. Click the button below to set a new password:
            </p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetUrl}" 
                 style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
                Reset Password
              </a>
            </div>
            
            <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 4px;">
              <p style="margin: 0; color: #856404; font-size: 14px;">
                <strong>Security Notice:</strong> This link expires in 1 hour. If you didn't request this reset, please ignore this email.
              </p>
            </div>
            
            <p style="color: #666; font-size: 14px;">
              If the button doesn't work, copy and paste this link into your browser:<br>
              <code style="background: #f8f9fa; padding: 2px 4px; border-radius: 3px; word-break: break-all;">${resetUrl}</code>
            </p>
          </div>
          
          <div style="text-align: center; margin-top: 30px; color: #888; font-size: 12px;">
            <p>© ${new Date().getFullYear()} Commune Apartments. All rights reserved.</p>
          </div>
        </div>
      `,
    };

    const result = await transporter.sendMail(mailOptions);
    console.log(`✅ Password reset email sent to ${email}`);
    return result;
  } catch (error) {
    console.error("📧 Password reset email error:", error);
    throw createError("EMAIL_ERROR", "Failed to send password reset email");
  }
};

// Complaint email templates
const getComplaintEmailTemplate = (type, data) => {
  const baseStyle = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; text-align: center; margin-bottom: 30px;">
        <h1 style="margin: 0; font-size: 28px;">🏠 Commune Apartments</h1>
        <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.9;">Complaint Management System</p>
      </div>
  `;

  const footerStyle = `
      <div style="text-align: center; margin-top: 30px; color: #888; font-size: 12px;">
        <p>© ${new Date().getFullYear()} Commune Apartments. All rights reserved.</p>
        <p>For urgent matters, please contact your building manager directly.</p>
      </div>
    </div>
  `;

  const templates = {
    new_complaint: {
      subject: `New Complaint Submitted - ${data.complaintNumber}`,
      html: `
        ${baseStyle}
        <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          <h2 style="color: #333; margin-top: 0;">Complaint Submitted Successfully</h2>
          <p style="color: #666; font-size: 16px; line-height: 1.5;">
            Hello ${data.tenantName},<br><br>
            Thank you for submitting your complaint. We have received your request and will address it promptly.
          </p>
          
          <div style="background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #495057; margin-top: 0; margin-bottom: 15px;">Complaint Details</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr style="border-bottom: 1px solid #dee2e6;">
                <td style="padding: 8px 0; font-weight: bold; color: #495057; width: 150px;">Complaint Number:</td>
                <td style="padding: 8px 0; color: #666;">${data.complaintNumber}</td>
              </tr>
              <tr style="border-bottom: 1px solid #dee2e6;">
                <td style="padding: 8px 0; font-weight: bold; color: #495057;">Category:</td>
                <td style="padding: 8px 0; color: #666;">${data.category}</td>
              </tr>
              <tr style="border-bottom: 1px solid #dee2e6;">
                <td style="padding: 8px 0; font-weight: bold; color: #495057;">Priority:</td>
                <td style="padding: 8px 0; color: #666;">
                  <span style="background: ${data.priority === 'urgent' ? '#dc3545' : data.priority === 'high' ? '#fd7e14' : '#ffc107'}; 
                               color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px; text-transform: uppercase;">
                    ${data.priority}
                  </span>
                </td>
              </tr>
              <tr style="border-bottom: 1px solid #dee2e6;">
                <td style="padding: 8px 0; font-weight: bold; color: #495057;">Title:</td>
                <td style="padding: 8px 0; color: #666;">${data.title}</td>
              </tr>
              <tr style="border-bottom: 1px solid #dee2e6;">
                <td style="padding: 8px 0; font-weight: bold; color: #495057;">Building:</td>
                <td style="padding: 8px 0; color: #666;">${data.buildingName}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; font-weight: bold; color: #495057;">Status:</td>
                <td style="padding: 8px 0; color: #666;">
                  <span style="background: #28a745; color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px; text-transform: uppercase;">
                    Submitted
                  </span>
                </td>
              </tr>
            </table>
          </div>
          
          <div style="background: #d4edda; border-left: 4px solid #28a745; padding: 15px; margin: 20px 0; border-radius: 4px;">
            <p style="margin: 0; color: #155724; font-size: 14px;">
              <strong>What's Next?</strong><br>
              • Our team will review your complaint within 24 hours<br>
              • You'll receive email updates on progress<br>
              • You can track the status in your tenant portal
            </p>
          </div>
        </div>
        ${footerStyle}
      `,
    },

    status_update: {
      subject: `Complaint Update - ${data.complaintNumber}`,
      html: `
        ${baseStyle}
        <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          <h2 style="color: #333; margin-top: 0;">Complaint Status Update</h2>
          <p style="color: #666; font-size: 16px; line-height: 1.5;">
            Hello ${data.tenantName},<br><br>
            Your complaint has been updated. Here are the latest details:
          </p>
          
          <div style="background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #495057; margin-top: 0; margin-bottom: 15px;">Complaint: ${data.title}</h3>
            <p style="margin: 0 0 10px 0;"><strong>Complaint Number:</strong> ${data.complaintNumber}</p>
            <p style="margin: 0 0 10px 0;"><strong>Previous Status:</strong> 
              <span style="color: #6c757d; text-transform: capitalize;">${data.previousStatus}</span>
            </p>
            <p style="margin: 0 0 15px 0;"><strong>Current Status:</strong> 
              <span style="background: ${data.status === 'resolved' ? '#28a745' : data.status === 'in_progress' ? '#17a2b8' : '#ffc107'}; 
                           color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px; text-transform: uppercase;">
                ${data.status.replace('_', ' ')}
              </span>
            </p>
            ${data.assignedTo ? `<p style="margin: 0 0 10px 0;"><strong>Assigned To:</strong> ${data.assignedTo}</p>` : ''}
            ${data.updateNote ? `
              <div style="background: #fff; border-left: 4px solid #17a2b8; padding: 15px; margin: 15px 0; border-radius: 4px;">
                <p style="margin: 0; color: #0c5460; font-size: 14px;">
                  <strong>Update Note:</strong><br>
                  ${data.updateNote}
                </p>
              </div>
            ` : ''}
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/tenant/complaints" 
               style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
              View Complaint Details
            </a>
          </div>
        </div>
        ${footerStyle}
      `,
    },

    resolved: {
      subject: `Complaint Resolved - ${data.complaintNumber}`,
      html: `
        ${baseStyle}
        <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          <h2 style="color: #28a745; margin-top: 0;">✅ Complaint Resolved</h2>
          <p style="color: #666; font-size: 16px; line-height: 1.5;">
            Hello ${data.tenantName},<br><br>
            Great news! Your complaint has been successfully resolved.
          </p>
          
          <div style="background: #d4edda; border: 1px solid #c3e6cb; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #155724; margin-top: 0; margin-bottom: 15px;">${data.title}</h3>
            <p style="margin: 0 0 10px 0; color: #155724;"><strong>Complaint Number:</strong> ${data.complaintNumber}</p>
            <p style="margin: 0 0 10px 0; color: #155724;"><strong>Resolved Date:</strong> ${new Date(data.resolvedAt).toLocaleDateString()}</p>
            ${data.resolutionNotes ? `
              <div style="background: #fff; border-left: 4px solid #28a745; padding: 15px; margin: 15px 0; border-radius: 4px;">
                <p style="margin: 0; color: #155724; font-size: 14px;">
                  <strong>Resolution Details:</strong><br>
                  ${data.resolutionNotes}
                </p>
              </div>
            ` : ''}
          </div>
          
          <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 4px;">
            <p style="margin: 0; color: #856404; font-size: 14px;">
              <strong>We Value Your Feedback!</strong><br>
              Please take a moment to rate your experience and help us improve our services.
            </p>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/tenant/complaints/${data.complaintId}" 
               style="background: #28a745; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; margin-right: 10px;">
              Rate & Review
            </a>
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/tenant/complaints" 
               style="background: #6c757d; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
              View All Complaints
            </a>
          </div>
        </div>
        ${footerStyle}
      `,
    },

    admin_notification: {
      subject: `New Complaint Requires Attention - ${data.complaintNumber}`,
      html: `
        ${baseStyle}
        <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          <h2 style="color: #dc3545; margin-top: 0;">🚨 New Complaint Alert</h2>
          <p style="color: #666; font-size: 16px; line-height: 1.5;">
            Hello ${data.adminName || 'Admin'},<br><br>
            A new complaint has been submitted and requires your attention.
          </p>
          
          <div style="background: #f8d7da; border: 1px solid #f5c6cb; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #721c24; margin-top: 0; margin-bottom: 15px;">Complaint Details</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr style="border-bottom: 1px solid #f5c6cb;">
                <td style="padding: 8px 0; font-weight: bold; color: #721c24; width: 150px;">Complaint Number:</td>
                <td style="padding: 8px 0; color: #721c24;">${data.complaintNumber}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f5c6cb;">
                <td style="padding: 8px 0; font-weight: bold; color: #721c24;">Tenant:</td>
                <td style="padding: 8px 0; color: #721c24;">${data.tenantName}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f5c6cb;">
                <td style="padding: 8px 0; font-weight: bold; color: #721c24;">Building:</td>
                <td style="padding: 8px 0; color: #721c24;">${data.buildingName}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f5c6cb;">
                <td style="padding: 8px 0; font-weight: bold; color: #721c24;">Unit:</td>
                <td style="padding: 8px 0; color: #721c24;">${data.unitNumber || 'N/A'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f5c6cb;">
                <td style="padding: 8px 0; font-weight: bold; color: #721c24;">Category:</td>
                <td style="padding: 8px 0; color: #721c24;">${data.category}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f5c6cb;">
                <td style="padding: 8px 0; font-weight: bold; color: #721c24;">Priority:</td>
                <td style="padding: 8px 0; color: #721c24;">
                  <span style="background: ${data.priority === 'urgent' ? '#dc3545' : data.priority === 'high' ? '#fd7e14' : '#ffc107'}; 
                               color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px; text-transform: uppercase;">
                    ${data.priority}
                  </span>
                </td>
              </tr>
              <tr>
                <td style="padding: 8px 0; font-weight: bold; color: #721c24;">Submitted:</td>
                <td style="padding: 8px 0; color: #721c24;">${new Date(data.createdAt).toLocaleString()}</td>
              </tr>
            </table>
            
            <div style="margin-top: 15px;">
              <p style="margin: 0 0 5px 0; font-weight: bold; color: #721c24;">Issue Description:</p>
              <p style="margin: 0; color: #721c24; font-style: italic;">"${data.description}"</p>
            </div>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/admin/complaints" 
               style="background: #dc3545; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
              Manage Complaint
            </a>
          </div>
        </div>
        ${footerStyle}
      `,
    },
  };

  return templates[type] || templates.new_complaint;
};

// Send complaint notification emails
export const sendComplaintEmail = async (type, recipientEmail, data) => {
  try {
    const transporter = createTransporter();
    const template = getComplaintEmailTemplate(type, data);

    const mailOptions = {
      from: {
        name: "Commune Apartments",
        address: process.env.EMAIL_USER,
      },
      to: recipientEmail,
      subject: template.subject,
      html: template.html,
    };

    console.log(`📧 Sending ${type} complaint email to ${recipientEmail}`);
    const result = await transporter.sendMail(mailOptions);
    console.log(`✅ Complaint email sent successfully to ${recipientEmail}`);
    
    return result;
  } catch (error) {
    console.error("📧 Complaint email error:", error);
    throw createError("EMAIL_ERROR", "Failed to send complaint notification email");
  }
};

// Send lead onboarding email
export const sendLeadOnboardingEmail = async (leadData) => {
  try {
    const transporter = createTransporter();
    
    const mailOptions = {
      from: {
        name: "Pankaj Teja - Commune Apartments",
        address: process.env.EMAIL_USER,
      },
      to: leadData.email,
      subject: `Welcome to Commune Quartex - ${leadData.name}!`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; line-height: 1.6;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; text-align: center; margin-bottom: 30px;">
            <h1 style="margin: 0; font-size: 28px;">🏠 Commune Quartex</h1>
            <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.9;">Premium Co-Living Experience</p>
          </div>
          
          <div style="background: white; padding: 0; border-radius: 10px;">
            <p style="font-size: 16px; margin-bottom: 20px;">Hi <strong>${leadData.name}</strong>,</p>
            
            <p style="font-size: 16px; margin-bottom: 20px;">Greetings from Commune!!!</p>
            
            <p style="font-size: 16px; margin-bottom: 20px;">We would love to host you at Commune Quartex at Sector 57, kindly note the below mail for our offerings to you.</p>
            
            <div style="background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px; padding: 25px; margin: 30px 0;">
              <h3 style="color: #495057; margin-top: 0; margin-bottom: 20px;">📍 Property Details</h3>
              <p style="margin: 8px 0;"><strong>Address:</strong> Commune Quartex / House No 1578 Sector 57, Gurgaon</p>
              <p style="margin: 8px 0;"><strong>Occupancy:</strong> Single Occupancy</p>
              <p style="margin: 8px 0;"><strong>Room:</strong> Room No 203</p>
              <p style="margin: 8px 0;"><strong>Monthly Rent:</strong> INR 33,000 per month (GST Extra @ 12%)</p>
              <p style="margin: 8px 0;"><strong>Refundable Security Deposit:</strong> INR 33,000</p>
              <p style="margin: 8px 0;"><strong>Notice Period:</strong> 1 Full Calendar month i.e. From the 1st of a month till the last date of a month (No Lock-In Period)</p>
            </div>
            
            <h3 style="color: #495057; margin-top: 30px; margin-bottom: 15px;">🌟 You are being offered the following facilities:</h3>
            
            <div style="background: #e3f2fd; border-left: 4px solid #2196f3; padding: 20px; margin: 20px 0; border-radius: 4px;">
              <h4 style="color: #1565c0; margin-top: 0; margin-bottom: 12px;">Core Offering -</h4>
              <ul style="margin: 0; padding-left: 20px; color: #333;">
                <li>Luxury Apartment Located in the heart of Millennium City.</li>
                <li>Fully Furnished Room with Air-Conditioning (In Room electricity charged @ Rs 10 per unit)</li>
                <li>100% Power backup 24*7</li>
                <li>Washroom with Geyser</li>
                <li>Full Sized Bed & Wardrobe</li>
                <li>LED TV</li>
                <li>Self-Help Amenities for Laundry, Ironing & Cooking</li>
              </ul>
            </div>
            
            <div style="background: #f3e5f5; border-left: 4px solid #9c27b0; padding: 20px; margin: 20px 0; border-radius: 4px;">
              <h4 style="color: #7b1fa2; margin-top: 0; margin-bottom: 12px;">Premium Offering -</h4>
              <ul style="margin: 0; padding-left: 20px; color: #333;">
                <li>Lounge access</li>
                <li>Homely Decor with Aesthetic Appeal</li>
                <li>Daily Housekeeping & Weekly Bed Turn Down</li>
              </ul>
            </div>
            
            <div style="background: #e8f5e8; border-left: 4px solid #4caf50; padding: 20px; margin: 20px 0; border-radius: 4px;">
              <h4 style="color: #388e3c; margin-top: 0; margin-bottom: 12px;">Complimentary Services -</h4>
              <ul style="margin: 0; padding-left: 20px; color: #333;">
                <li>High-Speed WiFi</li>
                <li>Repairs & Maintenance</li>
                <li>Daily Housekeeping</li>
                <li>Daily Breakfast, Dinner & Weekend lunches</li>
              </ul>
            </div>
            
            <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 20px; margin: 30px 0; border-radius: 4px;">
              <h4 style="color: #856404; margin-top: 0; margin-bottom: 15px;">📄 Required Documents:</h4>
              <p style="margin: 0; color: #856404;">Kindly mail the following scanned documents:</p>
              <ul style="margin: 10px 0 0 0; padding-left: 20px; color: #856404;">
                <li>Photo ID proof with a permanent address (Preferably Aadhaar Card)</li>
                <li>2 emergency contacts details</li>
                <li>Details of the workplace (Business Card / Letter of Appointment)</li>
              </ul>
            </div>
            
            <div style="background: #d4edda; border: 1px solid #c3e6cb; border-radius: 8px; padding: 25px; margin: 30px 0;">
              <h4 style="color: #155724; margin-top: 0; margin-bottom: 15px;">💳 Payment Details:</h4>
              <p style="margin: 8px 0; color: #155724;">Please send the below-mentioned amount to the following bank account:</p>
              
              <div style="background: white; padding: 15px; border-radius: 5px; margin: 15px 0;">
                <h5 style="color: #155724; margin-top: 0; margin-bottom: 10px;">ACCOUNT DETAILS:</h5>
                <p style="margin: 5px 0; color: #333;"><strong>A/c Name:</strong> Commune Apartment LLP</p>
                <p style="margin: 5px 0; color: #333;"><strong>Bank:</strong> IndusInd Bank</p>
                <p style="margin: 5px 0; color: #333;"><strong>Account Number:</strong> 201002351330</p>
                <p style="margin: 5px 0; color: #333;"><strong>IFSC Code:</strong> INDB0000673</p>
                <p style="margin: 5px 0; color: #333;"><strong>MICR Code:</strong> 110234062</p>
                <p style="margin: 5px 0; color: #333;"><strong>Branch:</strong> Arjun Marg, DLF-1, Gurgaon</p>
                <p style="margin: 5px 0; color: #333;"><strong>UPI:</strong> Q89146333@ybl</p>
              </div>
              
              <p style="margin: 15px 0 0 0; color: #155724;"><strong>Security Deposit = INR 33,000</strong></p>
              <p style="margin: 5px 0; color: #155724;">Rental for February'25 = INR____ (Payable post move in)</p>
              <p style="margin: 5px 0; color: #155724;"><strong>Total Amount = INR 33,000</strong></p>
              <p style="margin: 15px 0 0 0; color: #155724;"><strong>Move-In Date - 01.02.2025</strong></p>
            </div>
            
            <p style="font-size: 16px; margin: 30px 0; text-align: center;">Hope you have a wonderful stay with us here. Welcome to the family! :)</p>
            
            <div style="background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px; padding: 20px; margin: 30px 0; text-align: center;">
              <p style="margin: 0 0 15px 0; font-size: 16px;">Please follow us on</p>
              <p style="margin: 0 0 15px 0;"><a href="https://www.instagram.com/commune.apartment/" style="color: #667eea; text-decoration: none;">https://www.instagram.com/commune.apartment/</a></p>
              
              <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h4 style="margin: 0 0 10px 0;">🌟 Join Commune Rewards! 🌟</h4>
                <p style="margin: 0 0 10px 0; font-size: 14px;">Your stay at Commune Apartment gets even more rewarding! 🎉</p>
                <p style="margin: 0 0 15px 0; font-size: 14px;">Earn points for rent payments, referrals, and community activities. Redeem them for rent discounts, free services, and VIP perks! 💰✨</p>
                <p style="margin: 0 0 10px 0; font-size: 14px;">🔗 Learn more: <a href="https://communeapartment.com/rewards/" style="color: #fff; text-decoration: underline;">https://communeapartment.com/rewards/</a></p>
                <p style="margin: 0; font-size: 14px;">🚀 Get 500 points! Follow us on IG @commune.apartment and send a screenshot to rewards@commune-apartment.com</p>
              </div>
            </div>
            
            <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #dee2e6;">
              <p style="margin: 0; font-size: 16px;"><strong>Best Regards,</strong></p>
              <p style="margin: 5px 0 0 0; font-size: 16px;"><strong>Pankaj Teja</strong></p>
              <p style="margin: 5px 0 0 0; font-size: 16px;">8448800321</p>
            </div>
          </div>
          
          <div style="text-align: center; margin-top: 30px; color: #888; font-size: 12px;">
            <p>© ${new Date().getFullYear()} Commune Apartments. All rights reserved.</p>
            <p>This email contains important information about your accommodation at Commune Quartex.</p>
          </div>
        </div>
      `,
    };

    console.log(`📧 Sending onboarding email to ${leadData.email} for ${leadData.name}`);
    const result = await transporter.sendMail(mailOptions);
    console.log(`✅ Onboarding email sent successfully to ${leadData.email}`);
    
    return result;
  } catch (error) {
    console.error("📧 Onboarding email error:", error);
    throw createError("EMAIL_ERROR", "Failed to send onboarding email");
  }
};

// Test email configuration
export const testEmailConfiguration = async () => {
  try {
    const transporter = createTransporter();
    await transporter.verify();
    console.log("✅ Email configuration is valid");
    return true;
  } catch (error) {
    console.error("❌ Email configuration error:", error.message);
    return false;
  }
};

export default {
  sendOTP,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendComplaintEmail,
  sendLeadOnboardingEmail,
  testEmailConfiguration,
};
