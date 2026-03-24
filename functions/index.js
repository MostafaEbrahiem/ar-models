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
// 2. THE PRODUCTION AI GENERATOR
// ==========================================
exports.generate3DModel = onRequest(
    { 
        timeoutSeconds: 540,  // 9 minutes of patience!
        memory: "1GiB",       
        cors: true            
    }, 
    async (req, res) => {
        res.set('Access-Control-Allow-Origin', '*');

        try {
            const { imageUrl, uid } = req.body;
            
            if (!imageUrl || !uid) {
                return res.status(400).send({ error: "Missing image or User ID." });
            }

            console.log("Sending image to Tencent Hunyuan-3D-3.1...");

            const replicate = new Replicate({
                auth: process.env.REPLICATE_API_TOKEN, 
            });

            // 1. THE REAL AI
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

            // ==========================================
            // 2. THE GOLDEN FIX (From your documentation find!)
            // ==========================================
            let replicateUrl = "";
            
            if (output && typeof output.url === 'function') {
                // The new SDK method you found!
                replicateUrl = output.url(); 
            } else if (typeof output === 'string') {
                replicateUrl = output;
            } else if (Array.isArray(output)) {
                // Sometimes it returns an array of File Objects
                const firstItem = output[0];
                if (firstItem && typeof firstItem.url === 'function') replicateUrl = firstItem.url();
                else if (typeof firstItem === 'string') replicateUrl = firstItem;
            } else if (output && typeof output === 'object') {
                replicateUrl = output.mesh || output.model || output.glb;
            }

            if (!replicateUrl || typeof replicateUrl !== 'string') {
                throw new Error("Could not extract 3D file URL: " + JSON.stringify(output));
            }

            console.log("Found URL! Downloading from Replicate CDN...");

            // 3. Server securely downloads the file
            const fileResponse = await fetch(replicateUrl, {
                headers: { "Authorization": `Bearer ${process.env.REPLICATE_API_TOKEN}` }
            });

            if (!fileResponse.ok) throw new Error("Failed to download file from Replicate.");

            const arrayBuffer = await fileResponse.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // 4. Server saves directly to Firebase
            const bucket = admin.storage().bucket("3dmosta1001");
            const safeFileName = `${uid}_AI_Gen_${Date.now()}.glb`;
            const file = bucket.file(`models/${safeFileName}`);

            await file.save(buffer, {
                metadata: { contentType: 'model/gltf-binary' }
            });

            // 5. Send back the secure Firebase link
            const encodedPath = encodeURIComponent(`models/${safeFileName}`);
            const finalFirebaseUrl = `https://firebasestorage.googleapis.com/v0/b/3dmosta1001/o/${encodedPath}?alt=media`;

            console.log("Securely saved to Firebase!");
            res.status(200).send({ glbUrl: finalFirebaseUrl, fileName: safeFileName });

        } catch (error) {
            console.error("AI Generation Error:", error);
            res.status(500).send({ error: "Server Error: " + error.message });
        }
    }
);