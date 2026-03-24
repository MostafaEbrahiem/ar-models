const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Replicate = require("replicate");

admin.initializeApp();
const db = admin.firestore();

// ==========================================
// 1. THE PAYPAL WEBHOOK 
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
exports.generate3DModel = functions
    .runWith({
        timeoutSeconds: 300, 
        memory: "1GB" // Boosted memory to prevent crashing
    })
    .https.onRequest(async (req, res) => {
        // BULLETPROOF CORS HANDSHAKE
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type');

        // Handle pre-flight requests immediately
        if (req.method === 'OPTIONS') {
            res.status(204).send('');
            return;
        }

        try {
            const { imageUrl } = req.body;
            
            if (!imageUrl) {
                return res.status(400).send({ error: "No image provided." });
            }

            const replicate = new Replicate({
                auth: process.env.REPLICATE_API_TOKEN, 
            });

            console.log("Sending image to Tencent Hunyuan-3D-3.1...");

            const output = await replicate.run(
                "tencent/hunyuan-3d-3.1",
                {
                    input: {
                        image: imageUrl,
                        remove_background: true,
                        steps: 30 
                    }
                }
            );

            const finalModelUrl = output.mesh || output; 
            console.log("Success! GLB generated:", finalModelUrl);
            
            res.status(200).send({ glbUrl: finalModelUrl });

        } catch (error) {
            console.error("AI Generation Error:", error);
            res.status(500).send({ error: "Replicate Error: " + error.message });
        }
    });