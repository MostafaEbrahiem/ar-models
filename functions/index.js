const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Replicate = require("replicate");
const cors = require("cors")({ origin: true }); // Allows your website to talk to the server

admin.initializeApp();
const db = admin.firestore();

// ==========================================
// 1. THE PAYPAL WEBHOOK (Already Working)
// ==========================================
exports.paypalWebhook = functions.https.onRequest(async (req, res) => {
    try {
        const payerEmail = req.body.resource.subscriber.email_address;
        if (!payerEmail) return res.status(400).send("No email found");

        const userModelsQuery = await db.collection("clients").where("userEmail", "==", payerEmail).get();
        if (userModelsQuery.empty) return res.status(200).send("User has no models yet");

        const batch = db.batch();
        userModelsQuery.forEach((doc) => {
            batch.update(doc.ref, { maxScans: 1000, isPro: true });
        });

        await batch.commit();
        return res.status(200).send("Pro Upgrade Successful");
    } catch (error) {
        return res.status(500).send("Internal Server Error");
    }
});

// ==========================================
// 2. THE NEW AI 3D GENERATOR
// ==========================================
exports.generate3DModel = functions.https.onRequest((req, res) => {
    // CORS allows your frontend upload.html to safely request this function
    cors(req, res, async () => {
        try {
            const { imageUrl } = req.body;
            
            if (!imageUrl) {
                return res.status(400).send({ error: "No image provided." });
            }

            // PASTE YOUR REPLICATE API TOKEN HERE
            const replicate = new Replicate({
                auth: process.env.REPLICATE_API_TOKEN, 
            });

            console.log("Sending image to Stable Fast 3D...");

            // Call the state-of-the-art Stable Fast 3D model
            const output = await replicate.run(
                "stability-ai/stable-fast-3d",
                {
                    input: {
                        image: imageUrl,
                        texture_resolution: 1024,
                        foreground_ratio: 0.85
                    }
                }
            );

            // Replicate returns the URL to the newly generated .glb file
            console.log("Success! GLB generated:", output);
            res.status(200).send({ glbUrl: output });

        } catch (error) {
            console.error("AI Generation Error:", error);
            res.status(500).send({ error: "Failed to generate 3D model from image." });
        }
    });
});