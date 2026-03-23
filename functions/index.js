const functions = require("firebase-functions");
const admin = require("firebase-admin");

// Initialize with your project credentials
admin.initializeApp();
const db = admin.firestore();

// 1. This function wakes up when PayPal says "Success!"
exports.paypalWebhook = functions.https.onRequest(async (req, res) => {
    try {
        // Get the payer's email from the PayPal subscription data
        const payerEmail = req.body.resource.subscriber.email_address;

        if (!payerEmail) {
            console.error("No email found in PayPal payload");
            return res.status(400).send("No email found");
        }

        // 2. Find all models in Firestore belonging to this email
        const userModelsQuery = await db.collection("clients")
            .where("userEmail", "==", payerEmail)
            .get();

        if (userModelsQuery.empty) {
            console.log(`User ${payerEmail} paid, but has no models yet.`);
            return res.status(200).send("User has no models yet");
        }

        // 3. Batch Update: Turn on "Pro" for all their models
        const batch = db.batch();
        userModelsQuery.forEach((doc) => {
            batch.update(doc.ref, { 
                maxScans: 1000, 
                isPro: true 
            });
        });

        await batch.commit();
        console.log(`SUCCESS: Upgraded ${payerEmail} to Pro (1000 scans).`);
        
        return res.status(200).send("Pro Upgrade Successful");
    } catch (error) {
        console.error("Webhook Error:", error);
        return res.status(500).send("Internal Server Error");
    }
});

// Bypassing Google Cloud revision glitch