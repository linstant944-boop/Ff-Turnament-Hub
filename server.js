require("dotenv").config();

const fs = require("fs");
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 10000;

let db = null;

/* =========================================================
   FIREBASE
========================================================= */

try {
  if (
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON &&
    process.env.FIREBASE_DATABASE_URL
  ) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(
          JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
        ),
        databaseURL: process.env.FIREBASE_DATABASE_URL
      });
    }

    db = admin.database();
    console.log("Firebase connected");
  } else {
    console.log("Firebase environment variables are missing");
  }
} catch (error) {
  console.error("Firebase error:", error.message);
}

/* =========================================================
   RAZORPAY
========================================================= */

const rz =
  process.env.RAZORPAY_KEY_ID &&
  process.env.RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
      })
    : null;

/* =========================================================
   PUBLIC DIRECTORY
========================================================= */

const publicDir = path.join(__dirname, "public");
const indexFile = path.join(publicDir, "index.html");

console.log("Server directory:", __dirname);
console.log("Public directory:", publicDir);
console.log("Index file:", indexFile);
console.log("Index exists:", fs.existsSync(indexFile));

/* =========================================================
   STATIC FILES
========================================================= */

app.use(express.static(publicDir));

/* =========================================================
   RAZORPAY WEBHOOK
   IMPORTANT: raw body required
========================================================= */

app.post(
  "/api/razorpay/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

      if (!secret) {
        return res.status(500).json({
          ok: false,
          error: "RAZORPAY_WEBHOOK_SECRET is not configured"
        });
      }

      const signature = req.headers["x-razorpay-signature"];

      if (!signature || !Buffer.isBuffer(req.body)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid webhook body"
        });
      }

      const expected = crypto
        .createHmac("sha256", secret)
        .update(req.body)
        .digest("hex");

      if (
        signature.length !== expected.length ||
        !crypto.timingSafeEqual(
          Buffer.from(signature),
          Buffer.from(expected)
        )
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid signature"
        });
      }

      const event = JSON.parse(req.body.toString());

      console.log("Razorpay webhook:", event.event);

      /* -----------------------------------------------------
         PAYMENT CAPTURED
      ----------------------------------------------------- */

      if (event.event === "payment.captured") {
        const payment = event.payload?.payment?.entity;

        if (!payment?.id) {
          return res.status(400).json({
            ok: false,
            error: "Payment data missing"
          });
        }

        const paymentId = payment.id;

        const userId = String(
          payment.notes?.userId ||
          ""
        );

        const type =
          payment.notes?.type || "wallet";

        const amount =
          Number(payment.amount || 0) / 100;

        /* -----------------------------------------------
           DUPLICATE PAYMENT PROTECTION
        ------------------------------------------------ */

        if (db) {
          const paymentRef =
            db.ref("payments/" + paymentId);

          const existing =
            await paymentRef.once("value");

          if (existing.exists()) {
            console.log(
              "Payment already processed:",
              paymentId
            );

            return res.status(200).json({
              ok: true,
              duplicate: true
            });
          }

          const paymentData = {
            paymentId,
            orderId: payment.order_id || "",
            amount,
            currency: payment.currency || "INR",
            status: "SUCCESS",
            userId,
            type,
            method: payment.method || "",
            createdAt: Date.now()
          };

          await paymentRef.set(paymentData);

          /* -----------------------------------------------
             WALLET CREDIT
          ------------------------------------------------ */

          if (
            type === "wallet" &&
            userId
          ) {
            await db
              .ref("users/" + userId + "/wallet")
              .transaction((value) => {
                return (
                  (Number(value) || 0) +
                  amount
                );
              });

            console.log(
              "Wallet credited:",
              userId,
              amount
            );
          }

          /* -----------------------------------------------
             UPDATE PAYMENT INTENT
          ------------------------------------------------ */

          const intentsSnap =
            await db
              .ref("paymentIntents")
              .orderByChild("razorpayPaymentId")
              .equalTo(paymentId)
              .once("value");

          if (intentsSnap.exists()) {
            const updates = {};

            intentsSnap.forEach((child) => {
              updates[
                child.key + "/status"
              ] = "SUCCESS";

              updates[
                child.key + "/paymentId"
              ] = paymentId;

              updates[
                child.key + "/updatedAt"
              ] = Date.now();
            });

            await db
              .ref("paymentIntents")
              .update(updates);
          }

          /* -----------------------------------------------
             PAYMENT EVENT
          ------------------------------------------------ */

          await db.ref("events").push({
            type: "PAYMENT_RECEIVED",
            paymentId,
            amount,
            currency: payment.currency || "INR",
            userId,
            createdAt: Date.now()
          });
        }
      }

      /* -----------------------------------------------------
         PAYMENT FAILED
      ----------------------------------------------------- */

      if (event.event === "payment.failed") {
        const payment =
          event.payload?.payment?.entity;

        if (db && payment?.id) {
          await db
            .ref("paymentFailures/" + payment.id)
            .set({
              paymentId: payment.id,
              orderId: payment.order_id || "",
              amount:
                Number(payment.amount || 0) / 100,
              currency:
                payment.currency || "INR",
              userId:
                payment.notes?.userId || "",
              status: "FAILED",
              createdAt: Date.now()
            });
        }
      }

      return res.status(200).json({
        ok: true
      });

    } catch (error) {
      console.error(
        "Webhook error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: "Webhook error"
      });
    }
  }
);

/* =========================================================
   JSON BODY
========================================================= */

app.use(express.json({ limit: "5mb" }));

/* =========================================================
   FIREBASE MIDDLEWARE
========================================================= */

function requireDB(req, res, next) {
  if (!db) {
    return res.status(503).json({
      error: "Firebase is not configured"
    });
  }

  next();
}

/* =========================================================
   CONFIG
========================================================= */

app.get("/api/config", (req, res) => {
  res.json({
    razorpayKeyId:
      process.env.RAZORPAY_KEY_ID || "",
    manualPayment: true
  });
});

/* =========================================================
   ADMIN LOGIN
========================================================= */

app.post("/api/admin/login", async (req, res) => {
  try {
    const email =
      process.env.ADMIN_EMAIL ||
      "admin@example.com";

    const password =
      process.env.ADMIN_PASSWORD ||
      "ChangeThisStrongPassword123!";

    if (
      req.body.email !== email ||
      req.body.password !== password
    ) {
      return res.status(401).json({
        error: "Invalid admin login"
      });
    }

    return res.json({
      admin: true,
      email
    });

  } catch (error) {
    return res.status(500).json({
      error: "Admin login failed"
    });
  }
});

/* =========================================================
   ADMIN MATCHES
========================================================= */

app.get(
  "/api/admin/matches",
  requireDB,
  async (req, res) => {
    const snap =
      await db.ref("matches").once("value");

    const data = snap.val() || {};

    res.json(
      Object.entries(data).map(
        ([id, value]) => ({
          id,
          ...value
        })
      )
    );
  }
);

app.post(
  "/api/admin/matches/:id",
  requireDB,
  async (req, res) => {
    await db
      .ref("matches/" + req.params.id)
      .update(req.body || {});

    res.json({
      ok: true
    });
  }
);

app.delete(
  "/api/admin/matches/:id",
  requireDB,
  async (req, res) => {
    await db
      .ref("matches/" + req.params.id)
      .remove();

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   ADMIN USERS
========================================================= */

app.get(
  "/api/admin/users",
  requireDB,
  async (req, res) => {
    const snap =
      await db.ref("users").once("value");

    const users = [];

    snap.forEach((child) => {
      const user = child.val() || {};

      delete user.password;

      users.push({
        id: child.key,
        ...user
      });
    });

    res.json(users);
  }
);

app.post(
  "/api/admin/user/:id/block",
  requireDB,
  async (req, res) => {
    await db
      .ref("users/" + req.params.id + "/blocked")
      .set(!!req.body.blocked);

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   ADMIN WITHDRAWALS
========================================================= */

app.get(
  "/api/admin/withdrawals",
  requireDB,
  async (req, res) => {
    const snap =
      await db.ref("withdrawals").once("value");

    const output = [];

    Object.entries(
      snap.val() || {}
    ).forEach(([uid, values]) => {
      Object.entries(values || {}).forEach(
        ([id, value]) => {
          output.push({
            id,
            userId: uid,
            ...value
          });
        }
      );
    });

    res.json(output);
  }
);

app.post(
  "/api/admin/withdrawals/:uid/:id",
  requireDB,
  async (req, res) => {
    const ref =
      db.ref(
        "withdrawals/" +
        req.params.uid +
        "/" +
        req.params.id
      );

    const snap =
      await ref.once("value");

    if (!snap.exists()) {
      return res.status(404).json({
        error: "Withdrawal not found"
      });
    }

    const withdrawal = snap.val();

    if (
      withdrawal.status !== "PENDING"
    ) {
      return res.status(400).json({
        error: "Already processed"
      });
    }

    const status =
      req.body.status === "APPROVED"
        ? "APPROVED"
        : "REJECTED";

    /* -----------------------------------------------
       REFUND WALLET IF REJECTED
    ------------------------------------------------ */

    if (status === "REJECTED") {
      await db
        .ref(
          "users/" +
          withdrawal.userId +
          "/wallet"
        )
        .transaction(
          (value) =>
            (Number(value) || 0) +
            Number(withdrawal.amount || 0)
        );
    }

    await ref.update({
      status,
      processedAt: Date.now()
    });

    res.json({
      ok: true,
      status
    });
  }
);

/* =========================================================
   SUPPORT SETTINGS
========================================================= */

app.post(
  "/api/admin/support",
  requireDB,
  async (req, res) => {
    await db.ref("settings/support").set({
      whatsapp:
        req.body.whatsapp || "",
      message:
        req.body.message || "",
      updatedAt: Date.now()
    });

    res.json({
      ok: true
    });
  }
);

app.get(
  "/api/support",
  requireDB,
  async (req, res) => {
    const snap =
      await db.ref("settings/support")
        .once("value");

    res.json(
      snap.val() || {
        whatsapp: "",
        message: ""
      }
    );
  }
);

/* =========================================================
   PAYMENT SETTINGS
   RAZORPAY + MANUAL QR
========================================================= */

app.get(
  "/api/payment-settings",
  requireDB,
  async (req, res) => {
    const snap =
      await db
        .ref("settings/payment")
        .once("value");

    res.json(
      snap.val() || {
        enabled: true,
        manualEnabled: true,
        razorpayEnabled: true,
        minAmount: 10,
        maxAmount: 10000,
        qrImageUrl: "",
        upiId: "",
        merchantName: "FF Tournament Hub"
      }
    );
  }
);

app.post(
  "/api/admin/payment-settings",
  requireDB,
  async (req, res) => {
    const body = req.body || {};

    const settings = {
      enabled:
        body.enabled !== false,

      manualEnabled:
        body.manualEnabled !== false,

      razorpayEnabled:
        body.razorpayEnabled !== false,

      minAmount:
        Number(body.minAmount || 10),

      maxAmount:
        Number(body.maxAmount || 10000),

      qrImageUrl:
        String(body.qrImageUrl || ""),

      upiId:
        String(body.upiId || ""),

      merchantName:
        String(
          body.merchantName ||
          "FF Tournament Hub"
        ),

      updatedAt: Date.now()
    };

    await db
      .ref("settings/payment")
      .set(settings);

    res.json({
      ok: true,
      settings
    });
  }
);

/* =========================================================
   MANUAL PAYMENT INTENT
========================================================= */

app.post(
  "/api/payment-intent",
  requireDB,
  async (req, res) => {
    try {
      const userId =
        String(req.body.userId || "");

      const amount =
        Number(req.body.amount);

      if (
        !userId ||
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          error: "Invalid payment request"
        });
      }

      const configSnap =
        await db
          .ref("settings/payment")
          .once("value");

      const config =
        configSnap.val() || {};

      if (
        config.enabled === false ||
        config.manualEnabled === false
      ) {
        return res.status(400).json({
          error: "Manual payment is disabled"
        });
      }

      const minAmount =
        Number(config.minAmount || 10);

      const maxAmount =
        Number(config.maxAmount || 10000);

      if (
        amount < minAmount ||
        amount > maxAmount
      ) {
        return res.status(400).json({
          error:
            "Amount outside allowed range"
        });
      }

      const ref =
        db.ref("paymentIntents").push();

      const intentId = ref.key;

      const data = {
        id: intentId,
        userId,
        amount,
        status: "PENDING",
        paymentMethod: "MANUAL_QR",
        createdAt: Date.now()
      };

      await ref.set(data);

      res.json({
        ok: true,
        intentId,
        amount,
        status: "PENDING",
        qrImageUrl:
          config.qrImageUrl || "",
        upiId:
          config.upiId || "",
        merchantName:
          config.merchantName ||
          "FF Tournament Hub"
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Unable to create payment intent"
      });
    }
  }
);

/* =========================================================
   GET PAYMENT INTENT
========================================================= */

app.get(
  "/api/payment-intent/:id",
  requireDB,
  async (req, res) => {
    const snap =
      await db
        .ref(
          "paymentIntents/" +
          req.params.id
        )
        .once("value");

    if (!snap.exists()) {
      return res.status(404).json({
        error: "Payment request not found"
      });
    }

    res.json(snap.val());
  }
);

/* =========================================================
   SUBMIT MANUAL PAYMENT
   User enters UPI/reference number
========================================================= */

app.post(
  "/api/manual-payment/submit",
  requireDB,
  async (req, res) => {
    try {
      const intentId =
        String(req.body.intentId || "");

      const userId =
        String(req.body.userId || "");

      const transactionId =
        String(
          req.body.transactionId ||
          ""
        ).trim();

      const screenshotUrl =
        String(
          req.body.screenshotUrl ||
          ""
        ).trim();

      if (
        !intentId ||
        !userId ||
        !transactionId
      ) {
        return res.status(400).json({
          error:
            "Payment ID, user ID and transaction ID are required"
        });
      }

      const intentRef =
        db.ref(
          "paymentIntents/" +
          intentId
        );

      const snap =
        await intentRef.once("value");

      if (!snap.exists()) {
        return res.status(404).json({
          error: "Payment request not found"
        });
      }

      const intent = snap.val();

      if (intent.userId !== userId) {
        return res.status(403).json({
          error: "Invalid user"
        });
      }

      if (
        intent.status !== "PENDING"
      ) {
        return res.status(400).json({
          error:
            "Payment request already processed"
        });
      }

      const paymentData = {
        intentId,
        userId,
        amount:
          Number(intent.amount || 0),
        transactionId,
        screenshotUrl,
        paymentMethod: "MANUAL_QR",
        status: "PENDING",
        createdAt:
          intent.createdAt || Date.now(),
        submittedAt: Date.now()
      };

      await db
        .ref(
          "manualPayments/" +
          intentId
        )
        .set(paymentData);

      await intentRef.update({
        status: "SUBMITTED",
        transactionId,
        screenshotUrl,
        submittedAt: Date.now()
      });

      res.json({
        ok: true,
        status: "SUBMITTED",
        message:
          "Payment submitted. Admin approval pending."
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Unable to submit manual payment"
      });
    }
  }
);

/* =========================================================
   ADMIN MANUAL PAYMENTS
========================================================= */

app.get(
  "/api/admin/manual-payments",
  requireDB,
  async (req, res) => {
    const snap =
      await db
        .ref("manualPayments")
        .once("value");

    const payments =
      Object.entries(
        snap.val() || {}
      ).map(
        ([id, value]) => ({
          id,
          ...value
        })
      );

    payments.sort(
      (a, b) =>
        Number(b.submittedAt || 0) -
        Number(a.submittedAt || 0)
    );

    res.json(payments);
  }
);

/* =========================================================
   ADMIN APPROVE / REJECT MANUAL PAYMENT
========================================================= */

app.post(
  "/api/admin/manual-payment/:id",
  requireDB,
  async (req, res) => {
    try {
      const paymentId =
        req.params.id;

      const status =
        req.body.status === "APPROVED"
          ? "APPROVED"
          : "REJECTED";

      const paymentRef =
        db.ref(
          "manualPayments/" +
          paymentId
        );

      const snap =
        await paymentRef.once("value");

      if (!snap.exists()) {
        return res.status(404).json({
          error:
            "Manual payment not found"
        });
      }

      const payment =
        snap.val();

      if (
        payment.status !== "PENDING"
      ) {
        return res.status(400).json({
          error:
            "Payment already processed"
        });
      }

      /* -----------------------------------------------
         APPROVE
      ------------------------------------------------ */

      if (status === "APPROVED") {
        const amount =
          Number(payment.amount || 0);

        if (
          !payment.userId ||
          amount <= 0
        ) {
          return res.status(400).json({
            error:
              "Invalid payment data"
          });
        }

        /* Wallet credit */

        await db
          .ref(
            "users/" +
            payment.userId +
            "/wallet"
          )
          .transaction(
            (value) =>
              (Number(value) || 0) +
              amount
          );

        /* Payment history */

        await db
          .ref(
            "payments/manual_" +
            paymentId
          )
          .set({
            paymentId:
              "manual_" +
              paymentId,

            intentId:
              payment.intentId,

            userId:
              payment.userId,

            amount,

            currency: "INR",

            status: "SUCCESS",

            paymentMethod:
              "MANUAL_QR",

            transactionId:
              payment.transactionId,

            screenshotUrl:
              payment.screenshotUrl ||
              "",

            approvedAt:
              Date.now()
          });

        /* Update intent */

        if (payment.intentId) {
          await db
            .ref(
              "paymentIntents/" +
              payment.intentId
            )
            .update({
              status: "SUCCESS",
              approvedAt:
                Date.now()
            });
        }

        /* Event */

        await db
          .ref("events")
          .push({
            type:
              "MANUAL_PAYMENT_RECEIVED",

            paymentId:
              paymentId,

            userId:
              payment.userId,

            amount,

            createdAt:
              Date.now()
          });
      }

      /* -----------------------------------------------
         UPDATE PAYMENT STATUS
      ------------------------------------------------ */

      await paymentRef.update({
        status,
        processedAt:
          Date.now()
      });

      res.json({
        ok: true,
        status
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Unable to process manual payment"
      });
    }
  }
);

/* =========================================================
   REGISTER
========================================================= */

app.post(
  "/api/register",
  requireDB,
  async (req, res) => {
    try {
      const body =
        req.body || {};

      if (
        !body.name ||
        !body.email ||
        !body.password ||
        !body.gameName
      ) {
        return res.status(400).json({
          error:
            "Required fields missing"
        });
      }

      const email =
        String(body.email)
          .trim()
          .toLowerCase();

      const existing =
        await db
          .ref("users")
          .orderByChild("email")
          .equalTo(email)
          .once("value");

      if (existing.exists()) {
        return res.status(409).json({
          error:
            "Email already registered"
        });
      }

      const ref =
        db.ref("users").push();

      const user = {
        id: ref.key,
        name:
          String(body.name).trim(),
        email,
        mobile:
          String(body.mobile || ""),
        password:
          String(body.password),
        gameName:
          String(body.gameName).trim(),
        wallet: 0,
        blocked: false,
        createdAt: Date.now()
      };

      await ref.set(user);

      const safeUser = {
        ...user
      };

      delete safeUser.password;

      res.json({
        user: safeUser
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Registration failed"
      });
    }
  }
);

/* =========================================================
   LOGIN
========================================================= */

app.post(
  "/api/login",
  requireDB,
  async (req, res) => {
    try {
      const email =
        String(
          req.body.email || ""
        )
          .trim()
          .toLowerCase();

      const password =
        String(
          req.body.password || ""
        );

      const snap =
        await db
          .ref("users")
          .orderByChild("email")
          .equalTo(email)
          .once("value");

      let user = null;

      snap.forEach((child) => {
        user = {
          id: child.key,
          ...child.val()
        };
      });

      if (
        !user ||
        user.password !== password
      ) {
        return res.status(401).json({
          error:
            "Invalid login"
        });
      }

      if (user.blocked) {
        return res.status(403).json({
          error:
            "Account blocked"
        });
      }

      delete user.password;

      res.json({
        user
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Login failed"
      });
    }
  }
);

/* =========================================================
   USER
========================================================= */

app.get(
  "/api/user/:id",
  requireDB,
  async (req, res) => {
    const snap =
      await db
        .ref(
          "users/" +
          req.params.id
        )
        .once("value");

    if (!snap.exists()) {
      return res.status(404).json({
        error: "User not found"
      });
    }

    const user =
      snap.val();

    delete user.password;

    res.json(user);
  }
);

/* =========================================================
   RAZORPAY CREATE ORDER
========================================================= */

app.post(
  "/api/create-order",
  requireDB,
  async (req, res) => {
    try {
      if (!rz) {
        return res.status(503).json({
          error:
            "Razorpay API keys are not configured"
        });
      }

      const userId =
        String(
          req.body.userId || ""
        );

      const amount =
        Number(
          req.body.amount
        );

      if (
        !userId ||
        !Number.isFinite(amount) ||
        amount < 10
      ) {
        return res.status(400).json({
          error:
            "Minimum ₹10"
        });
      }

      const order =
        await rz.orders.create({
          amount:
            Math.round(amount * 100),

          currency: "INR",

          receipt:
            "wallet_" +
            Date.now(),

          notes: {
            userId,
            type: "wallet"
          }
        });

      res.json(order);

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          error.message ||
          "Unable to create Razorpay order"
      });
    }
  }
);

/* =========================================================
   MATCHES
========================================================= */

app.get(
  "/api/matches",
  requireDB,
  async (req, res) => {
    const snap =
      await db
        .ref("matches")
        .once("value");

    res.json(
      Object.entries(
        snap.val() || {}
      ).map(
        ([id, value]) => ({
          id,
          ...value
        })
      )
    );
  }
);

/* =========================================================
   CREATE MATCH
========================================================= */

app.post(
  "/api/matches",
  requireDB,
  async (req, res) => {
    const ref =
      db.ref("matches").push();

    const body =
      req.body || {};

    const match = {
      ...body,

      entryFee:
        Number(body.entryFee || 0),

      prizePool:
        Number(body.prizePool || 0),

      maxPlayers:
        Number(body.maxPlayers || 50),

      joinedPlayers: 0,

      roomId: "",

      roomPassword: "",

      resultPosted: false,

      status: "UPCOMING",

      createdAt:
        Date.now()
    };

    await ref.set(match);

    res.json({
      id: ref.key,
      ...match
    });
  }
);

/* =========================================================
   JOIN MATCH
========================================================= */

app.post(
  "/api/matches/:id/join",
  requireDB,
  async (req, res) => {
    try {
      const userId =
        String(
          req.body.userId || ""
        );

      const slot =
        Number(
          req.body.slot
        );

      const gameName =
        String(
          req.body.gameName || ""
        ).trim();

      const teamName =
        String(
          req.body.teamName || ""
        ).trim();

      const matchSnap =
        await db
          .ref(
            "matches/" +
            req.params.id
          )
          .once("value");

      const userSnap =
        await db
          .ref(
            "users/" +
            userId
          )
          .once("value");

      if (
        !matchSnap.exists() ||
        !userSnap.exists()
      ) {
        return res.status(404).json({
          error: "Not found"
        });
      }

      const match =
        matchSnap.val();

      const user =
        userSnap.val();

      if (!gameName) {
        return res.status(400).json({
          error:
            "Game name required"
        });
      }

      if (
        !Number.isInteger(slot) ||
        slot < 1 ||
        slot >
          Number(
            match.maxPlayers || 50
          )
      ) {
        return res.status(400).json({
          error:
            "Select a valid slot"
        });
      }

      if (user.blocked) {
        return res.status(403).json({
          error:
            "Account blocked"
        });
      }

      const entryFee =
        Number(
          match.entryFee || 0
        );

      if (
        Number(user.wallet || 0) <
        entryFee
      ) {
        return res.status(400).json({
          error:
            "Insufficient wallet"
        });
      }

      const joinSnap =
        await db
          .ref(
            "matchJoins/" +
            req.params.id +
            "/" +
            userId
          )
          .once("value");

      if (joinSnap.exists()) {
        return res.status(409).json({
          error:
            "Already joined"
        });
      }

      const slotRef =
        db.ref(
          "matchSlots/" +
          req.params.id +
          "/" +
          slot
        );

      const slotSnap =
        await slotRef.once("value");

      if (slotSnap.exists()) {
        return res.status(409).json({
          error:
            "This slot is already joined"
        });
      }

      if (
        Number(
          match.joinedPlayers || 0
        ) >=
        Number(
          match.maxPlayers || 50
        )
      ) {
        return res.status(400).json({
          error:
            "Match full"
        });
      }

      await db
        .ref(
          "users/" +
          userId +
          "/wallet"
        )
        .transaction(
          (value) =>
            (Number(value) || 0) -
            entryFee
        );

      await db
        .ref(
          "matches/" +
          req.params.id +
          "/joinedPlayers"
        )
        .transaction(
          (value) =>
            (Number(value) || 0) + 1
        );

      const joinData = {
        userId,
        name:
          user.name || "",
        gameName,
        teamName,
        slot,
        entryFee,
        joinedAt:
          Date.now()
      };

      await db
        .ref(
          "matchJoins/" +
          req.params.id +
          "/" +
          userId
        )
        .set(joinData);

      await slotRef.set(
        joinData
      );

      res.json({
        ok: true,
        slot
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Unable to join match"
      });
    }
  }
);

/* =========================================================
   MATCH SLOTS
========================================================= */

app.get(
  "/api/matches/:id/slots",
  requireDB,
  async (req, res) => {
    const snap =
      await db
        .ref(
          "matchSlots/" +
          req.params.id
        )
        .once("value");

    res.json(
      snap.val() || {}
    );
  }
);

/* =========================================================
   ROOM ACCESS
========================================================= */

app.get(
  "/api/matches/:id/access/:uid",
  requireDB,
  async (req, res) => {
    const joinSnap =
      await db
        .ref(
          "matchJoins/" +
          req.params.id +
          "/" +
          req.params.uid
        )
        .once("value");

    if (!joinSnap.exists()) {
      return res.status(403).json({
        error:
          "Join first"
      });
    }

    const matchSnap =
      await db
        .ref(
          "matches/" +
          req.params.id
        )
        .once("value");

    if (!matchSnap.exists()) {
      return res.status(404).json({
        error:
          "Match not found"
      });
    }

    const match =
      matchSnap.val();

    res.json({
      roomId:
        match.roomId ||
        "Not published",

      roomPassword:
        match.roomPassword ||
        "Not published"
    });
  }
);

/* =========================================================
   UPDATE ROOM
========================================================= */

app.post(
  "/api/matches/:id/room",
  requireDB,
  async (req, res) => {
    await db
      .ref(
        "matches/" +
        req.params.id
      )
      .update({
        roomId:
          req.body.roomId || "",

        roomPassword:
          req.body.roomPassword || ""
      });

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   RESULT
========================================================= */

app.post(
  "/api/matches/:id/result",
  requireDB,
  async (req, res) => {
    await db
      .ref(
        "matches/" +
        req.params.id
      )
      .update({
        resultPosted: true,

        result:
          req.body.result || [],

        status: "RESULT",

        resultUpdatedAt:
          Date.now()
      });

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   HISTORY
========================================================= */

app.get(
  "/api/history/:uid",
  requireDB,
  async (req, res) => {
    const [joinSnap, paymentSnap] =
      await Promise.all([
        db
          .ref("matchJoins")
          .once("value"),

        db
          .ref("payments")
          .once("value")
      ]);

    const joins = [];

    const joinData =
      joinSnap.val() || {};

    Object.entries(
      joinData
    ).forEach(
      ([matchId, users]) => {
        if (
          users &&
          users[req.params.uid]
        ) {
          joins.push({
            matchId,
            ...users[
              req.params.uid
            ]
          });
        }
      }
    );

    const payments =
      Object.values(
        paymentSnap.val() || {}
      ).filter(
        (payment) =>
          payment.userId ===
          req.params.uid
      );

    res.json({
      joins,
      payments
    });
  }
);

/* =========================================================
   NOTIFICATIONS
========================================================= */

app.get(
  "/api/notifications/:uid",
  requireDB,
  async (req, res) => {
    const snap =
      await db
        .ref("notifications")
        .once("value");

    const notifications =
      Object.values(
        snap.val() || {}
      )
        .filter(
          (item) =>
            !item.userId ||
            item.userId ===
              req.params.uid
        )
        .sort(
          (a, b) =>
            Number(
              b.createdAt || 0
            ) -
            Number(
              a.createdAt || 0
            )
        );

    res.json(
      notifications
    );
  }
);

/* =========================================================
   ADMIN NOTIFICATION
========================================================= */

app.post(
  "/api/admin/notify",
  requireDB,
  async (req, res) => {
    const ref =
      db
        .ref("notifications")
        .push();

    await ref.set({
      userId:
        req.body.userId || "",

      title:
        req.body.title ||
        "Announcement",

      message:
        req.body.message ||
        "",

      createdAt:
        Date.now()
    });

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   WITHDRAW
========================================================= */

app.post(
  "/api/withdraw",
  requireDB,
  async (req, res) => {
    try {
      const userId =
        String(
          req.body.userId || ""
        );

      const amount =
        Number(
          req.body.amount
        );

      const upi =
        String(
          req.body.upi || ""
        ).trim();

      if (
        !userId ||
        !upi ||
        !Number.isFinite(amount) ||
        amount < 50
      ) {
        return res.status(400).json({
          error:
            "Minimum ₹50 and UPI required"
        });
      }

      const walletRef =
        db.ref(
          "users/" +
          userId +
          "/wallet"
        );

      let successful =
        false;

      await walletRef.transaction(
        (value) => {
          const balance =
            Number(value) || 0;

          if (balance < amount) {
            return;
          }

          successful = true;

          return balance - amount;
        }
      );

      if (!successful) {
        return res.status(400).json({
          error:
            "Insufficient wallet"
        });
      }

      const ref =
        db
          .ref(
            "withdrawals/" +
            userId
          )
          .push();

      await ref.set({
        id: ref.key,
        userId,
        amount,
        upi,
        status: "PENDING",
        createdAt:
          Date.now()
      });

      res.json({
        ok: true,
        withdrawalId:
          ref.key
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Withdrawal failed"
      });
    }
  }
);

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "FF Tournament Hub",
      firebase:
        !!db,
      razorpay:
        !!rz,
      indexExists:
        fs.existsSync(indexFile),
      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   API 404
========================================================= */

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      error:
        "API endpoint not found"
    });
  }
);

/* =========================================================
   FRONTEND FALLBACK
   Express 5 compatible
========================================================= */

app.get(
  /^(?!\/api).*/,
  (req, res) => {
    if (!fs.existsSync(indexFile)) {
      console.error(
        "Missing frontend:",
        indexFile
      );

      return res.status(500).send(`
        <html>
          <head>
            <title>FF Tournament Hub</title>
          </head>
          <body style="font-family:Arial;padding:30px">
            <h2>FF Tournament Hub Server Running</h2>
            <p>Server is working, but <b>public/index.html</b> is missing.</p>
            <p>Please make sure your GitHub repository contains:</p>
            <pre>public/index.html</pre>
          </body>
        </html>
      `);
    }

    res.sendFile(indexFile);
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (error, req, res, next) => {
    console.error(
      "Server error:",
      error
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      error:
        "Internal server error"
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "================================="
    );

    console.log(
      "FF Tournament Hub Server Started"
    );

    console.log(
      "PORT:",
      PORT
    );

    console.log(
      "Firebase:",
      db ? "CONNECTED" : "NOT CONNECTED"
    );

    console.log(
      "Razorpay:",
      rz ? "CONFIGURED" : "NOT CONFIGURED"
    );

    console.log(
      "Frontend:",
      fs.existsSync(indexFile)
        ? "FOUND"
        : "MISSING"
    );

    console.log(
      "================================="
    );
  }
);
