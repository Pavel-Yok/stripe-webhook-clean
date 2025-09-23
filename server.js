import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import { google } from "googleapis";
import bodyParser from "body-parser";

dotenv.config();

const app = express();

const stripeSecretKey = process.env.STRIPE_MODE === "live"
  ? process.env.STRIPE_LIVE_SECRET_KEY_ENV
  : process.env.STRIPE_TEST_SECRET_KEY_ENV;

const webhookSecret = process.env.STRIPE_MODE === "live"
  ? process.env.STRIPE_LIVE_WEBHOOK_SECRET_ENV
  : process.env.STRIPE_TEST_WEBHOOK_SECRET_ENV;

if (!stripeSecretKey || !webhookSecret) {
  console.error("❌ Stripe secrets not found. Check your Cloud Run secret mappings.");
  process.exit(1);
}

console.log("🔑 Stripe mode:", process.env.STRIPE_MODE);
console.log("🔑 Stripe key loaded:", stripeSecretKey ? "Yes" : "No");
console.log("🔑 Webhook secret loaded:", webhookSecret ? "Yes" : "No");

const stripe = new Stripe(stripeSecretKey);

// Gmail OAuth2 setup
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID_ENV,
  process.env.GOOGLE_CLIENT_SECRET_ENV,
  process.env.GOOGLE_REDIRECT_URI_ENV
);
oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN_ENV });
const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

/* ======================
    HTML Email Templates
====================== */
function paymentReceivedTemplate(amount, currency) {
  return `...`; // Same as your original code
}

function paymentFailedTemplate(updateUrl) {
  return `...`; // Same as your original code
}

function renewalReminderTemplate(amount, currency, date) {
  return `...`; // Same as your original code
}

function trialEndingTemplate(date) {
  return `...`; // Same as your original code
}

/* ======================
    Gmail Send Function
====================== */
async function sendMail({ to, subject, body }) {
  if (!to) {
    console.error("⚠️ No customer email available, skipping.");
    return;
  }
  
  const rawMessage = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}`
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  try {
    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: rawMessage },
    });
    console.log(`📧 Email sent to ${to} for event: "${subject}"`);
  } catch (err) {
    console.error("❌ Failed to send Gmail notification:", err);
  }
}

/* ======================
    Stripe Webhook Handler
====================== */
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      console.log("✅ Webhook event verified:", event.type);
    } catch (err) {
      console.error("⚠️ Webhook signature verification failed.", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      let customerEmail = event.data.object.customer_email;
      if (!customerEmail && event.data.object.customer) {
        const customer = await stripe.customers.retrieve(event.data.object.customer);
        customerEmail = customer.email;
      }

      switch (event.type) {
        case "invoice.paid": {
          const amount = (event.data.object.amount_paid / 100).toFixed(2);
          const currency = event.data.object.currency.toUpperCase();
          await sendMail({
            to: customerEmail,
            subject: "Payment Received",
            body: paymentReceivedTemplate(amount, currency),
          });
          break;
        }
        case "invoice.payment_failed": {
          const session = await stripe.billingPortal.sessions.create({
            customer: event.data.object.customer,
            return_url: "https://yokweb.com/account",
          });
          await sendMail({
            to: customerEmail,
            subject: "Payment Failed — Update Your Card",
            body: paymentFailedTemplate(session.url),
          });
          break;
        }
        case "invoice.upcoming": {
          const amount = (event.data.object.amount_due / 100).toFixed(2);
          const currency = event.data.object.currency.toUpperCase();
          const date = new Date(event.data.object.next_payment_attempt * 1000).toLocaleDateString();
          await sendMail({
            to: customerEmail,
            subject: "Upcoming Renewal Reminder",
            body: renewalReminderTemplate(amount, currency, date),
          });
          break;
        }
        case "customer.subscription.trial_will_end": {
          const date = new Date(event.data.object.trial_end * 1000).toLocaleDateString();
          await sendMail({
            to: customerEmail,
            subject: "Trial Ending Soon",
            body: trialEndingTemplate(date),
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
  }
);

// Health check route for Cloud Run
app.get("/", (req, res) => {
  res.send("✅ Stripe Webhook service is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Webhook server running on port ${PORT}`);
});
