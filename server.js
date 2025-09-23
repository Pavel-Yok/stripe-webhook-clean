console.log("🚀 Test deployment from GitHub CI/CD at " + new Date().toISOString());

import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import { google } from "googleapis";
import bodyParser from "body-parser";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Gmail OAuth2 setup
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

/* ======================
   HTML Email Templates
====================== */

function paymentReceivedTemplate(amount, currency) {
  return `
  <div style="font-family: Arial, sans-serif; color: #333; padding: 20px;">
    <div style="text-align:center; margin-bottom:20px;">
      <img src="https://yokweb.com/yokweb-logo.png" alt="Yokweb Logo" width="120" style="border-radius: 8px;" />
    </div>
    <h2 style="color:#2e7d32;">Payment Confirmation</h2>
    <p>Hi,</p>
    <p>We’ve received your payment of <strong>${amount} ${currency}</strong>.</p>
    <p>Thank you for your trust in our services!</p>
    <div style="margin-top:30px; text-align:center;">
      <a href="https://yokweb.com/account" style="background:#2e7d32; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:bold;">Visit Your Account</a>
    </div>
  </div>`;
}

function paymentFailedTemplate(updateUrl) {
  return `
  <div style="font-family: Arial, sans-serif; color: #333; padding: 20px;">
    <div style="text-align:center; margin-bottom:20px;">
      <img src="https://yokweb.com/yokweb-logo.png" alt="Yokweb Logo" width="120" style="border-radius: 8px;" />
    </div>
    <h2 style="color:#c62828;">Payment Failed</h2>
    <p>Hi,</p>
    <p>Unfortunately, your recent payment attempt was not successful.</p>
    <p>Please update your payment information to continue enjoying our services.</p>
    <div style="margin-top:30px; text-align:center;">
      <a href="${updateUrl}" style="background:#c62828; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:bold;">Update Payment Info</a>
    </div>
  </div>`;
}

function renewalReminderTemplate(amount, currency, date) {
  return `
  <div style="font-family: Arial, sans-serif; color: #333; padding: 20px;">
    <div style="text-align:center; margin-bottom:20px;">
      <img src="https://yokweb.com/yokweb-logo.png" alt="Yokweb Logo" width="120" style="border-radius: 8px;" />
    </div>
    <h2 style="color:#1565c0;">Upcoming Renewal</h2>
    <p>Hi,</p>
    <p>This is a friendly reminder that your subscription will renew on <strong>${date}</strong> for <strong>${amount} ${currency}</strong>.</p>
    <p>No action is required if your payment details are up to date.</p>
    <div style="margin-top:30px; text-align:center;">
      <a href="https://yokweb.com/account" style="background:#1565c0; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:bold;">Manage Account</a>
    </div>
  </div>`;
}

function trialEndingTemplate(date) {
  return `
  <div style="font-family: Arial, sans-serif; color: #333; padding: 20px;">
    <div style="text-align:center; margin-bottom:20px;">
      <img src="https://yokweb.com/yokweb-logo.png" alt="Yokweb Logo" width="120" style="border-radius: 8px;" />
    </div>
    <h2 style="color:#f9a825;">Your Trial is Ending Soon</h2>
    <p>Hi,</p>
    <p>Your trial will end on <strong>${date}</strong>. Don’t miss out on the benefits — continue with a paid plan today.</p>
    <div style="margin-top:30px; text-align:center;">
      <a href="https://yokweb.com/pricing" style="background:#f9a825; color:#000; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:bold;">Upgrade Now</a>
    </div>
  </div>`;
}

/* ======================
   Stripe Webhook Handler
====================== */

app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];

  // Pick correct webhook secret depending on mode
  const stripeWebhookSecret = process.env.STRIPE_MODE === "live"
    ? process.env.STRIPE_LIVE_WEBHOOK_SECRET
    : process.env.STRIPE_TEST_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
  } catch (err) {
    console.error("⚠️ Webhook signature verification failed.", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Continue handling event types below...

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log("✅ Verified event received:", event.type);
  } catch (err) {
    console.error("⚠️ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "invoice.paid": {
        console.log("💰 Invoice paid!");
        let customerEmail = event.data.object.customer_email;

        // 🔎 Fetch from Customer object if missing
        if (!customerEmail && event.data.object.customer) {
          const customer = await stripe.customers.retrieve(event.data.object.customer);
          customerEmail = customer.email;
        }

        await sendMail({
          to: customerEmail,
          subject: "Payment Received",
          body: paymentReceivedTemplate(
            (event.data.object.amount_paid / 100).toFixed(2),
            event.data.object.currency.toUpperCase()
          )
        });
        break;
      }

      case "invoice.payment_failed": {
        console.log("❌ Invoice payment failed!");
        let customerEmail = event.data.object.customer_email;
        if (!customerEmail && event.data.object.customer) {
          const customer = await stripe.customers.retrieve(event.data.object.customer);
          customerEmail = customer.email;
        }

        const session = await stripe.billingPortal.sessions.create({
          customer: event.data.object.customer,
          return_url: "https://yokweb.com/account",
        });

        await sendMail({
          to: customerEmail,
          subject: "Payment Failed — Update Your Card",
          body: paymentFailedTemplate(session.url)
        });
        break;
      }

      case "invoice.upcoming": {
        console.log("📅 Upcoming invoice!");
        let customerEmail = event.data.object.customer_email;
        if (!customerEmail && event.data.object.customer) {
          const customer = await stripe.customers.retrieve(event.data.object.customer);
          customerEmail = customer.email;
        }

        await sendMail({
          to: customerEmail,
          subject: "Upcoming Renewal Reminder",
          body: renewalReminderTemplate(
            (event.data.object.amount_due / 100).toFixed(2),
            event.data.object.currency.toUpperCase(),
            new Date(event.data.object.next_payment_attempt * 1000).toLocaleDateString()
          )
        });
        break;
      }

      case "customer.subscription.trial_will_end": {
        console.log("⏳ Trial ending soon!");
        let customerEmail = event.data.object.customer_email;
        if (!customerEmail && event.data.object.customer) {
          const customer = await stripe.customers.retrieve(event.data.object.customer);
          customerEmail = customer.email;
        }

        await sendMail({
          to: customerEmail,
          subject: "Trial Ending Soon",
          body: trialEndingTemplate(
            new Date(event.data.object.trial_end * 1000).toLocaleDateString()
          )
        });
        break;
      }

      default:
        console.log("ℹ️ Unhandled event type:", event.type);
    }
  } catch (err) {
    console.error("❌ Error handling event:", err);
  }

  res.json({ received: true });
});

/* ======================
   Gmail Send Function
====================== */
async function sendMail({ to, subject, body }) {
  if (!to) {
    console.error("⚠️ No customer email available");
    return;
  }

  const rawMessage = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}`
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: rawMessage },
  });

  console.log(`📧 Email sent to ${to}: ${subject}`);
}

// Health check route for Cloud Run
app.get("/", (req, res) => {
  res.send("✅ Stripe Webhook service is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Webhook server running on port ${PORT}`);
});

