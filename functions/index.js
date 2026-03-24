const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const Replicate = require("replicate");

admin.initializeApp();
const db = admin.firestore();

// ==========================================
// 1. THE PAYPAL WEBHOOK 
// ==========================================
exports.paypalWebhook = onRequest(async (req, res) => {
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
// 2. THE NEW AI 3D GENERATOR (CHEAP POTATO v2)
// ==========================================
exports.generate3DModel = onRequest(
    { 
        timeoutSeconds: 300,  
        memory: "1GiB",       
        cors: true            
    }, 
    async (req, res) => {
        try {
            const { imageUrl, uid } = req.body;
            
            if (!imageUrl || !uid) {
                return res.status(400).send({ error: "Missing image or User ID." });
            }

            const replicate = new Replicate({
                auth: process.env.REPLICATE_API_TOKEN, 
            });

            console.log("Sending image to New Cheap Potato (Shap-E)...");

            // --- THE UPDATED MODEL YOU FOUND ---
            const output = await replicate.run(
                "guillaumemartinfesta/shap-e:60c562478d89bfa5309a1096263e2492bc504939c042292930243107cda02a63",
                {
                    input: { 
                        image: imageUrl, 
                    }
                }
            );

            // 1. Safely extract the GLB URL
            // Shap-E often returns a single string URL for the .glb file
            let replicateUrl = "";
            if (typeof output === 'string') {
                replicateUrl = output;
            } else if (Array.isArray(output)) {
                replicateUrl = output.find(u => typeof u === 'string' && u.endsWith('.glb')) || output[0];
            } else if (output && typeof output === 'object') {
                replicateUrl = output.mesh || output.model || Object.values(output).find(v => typeof v === 'string' && v.startsWith('http'));
            }

            if (!replicateUrl || typeof replicateUrl !== 'string') {
                throw new Error("Could not extract 3D file from AI output: " + JSON.stringify(output));
            }

            console.log("Downloading from Replicate CDN...");

            // 2. Server downloads the file
            const fileResponse = await fetch(replicateUrl);
            if (!fileResponse.ok) throw new Error("Failed to download from Replicate.");

            const arrayBuffer = await fileResponse.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // 3. Server saves directly to your Firebase Storage
            const bucket = admin.storage().bucket("3dmosta1001");
            const safeFileName = `${uid}_AI_Gen_${Date.now()}.glb`;
            const file = bucket.file(`models/${safeFileName}`);

            await file.save(buffer, {
                metadata: { contentType: 'model/gltf-binary' }
            });

            // 4. Send back the secure Firebase link
            const encodedPath = encodeURIComponent(`models/${safeFileName}`);
            const finalFirebaseUrl = `https://firebasestorage.googleapis.com/v0/b/3dmosta1001/o/${encodedPath}?alt=media`;

            console.log("Securely saved to Firebase!");
            res.status(200).send({ glbUrl: finalFirebaseUrl, fileName: safeFileName });

        } catch (error) {
            console.error("AI Generation Error:", error);
            res.status(500).send({ error: "Replicate Error: " + error.message });
        }
    }
);