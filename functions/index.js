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
// 2. THE NEW AI 3D GENERATOR (BULLETPROOF)
// ==========================================
exports.generate3DModel = onRequest(
    { 
        timeoutSeconds: 300,  
        memory: "1GiB",       
        cors: true            
    }, 
    async (req, res) => {
        try {
            // We now accept the user's UID from the frontend
            const { imageUrl, uid } = req.body;
            
            if (!imageUrl || !uid) {
                return res.status(400).send({ error: "Missing image or User ID." });
            }

            const replicate = new Replicate({
                auth: process.env.REPLICATE_API_TOKEN, 
            });

            console.log("Sending image to Tencent Hunyuan-3D...");

            const output = await replicate.run(
                "tencent/hunyuan-3d-3.1",
                {
                    input: { image: imageUrl, remove_background: true, steps: 30 }
                }
            );

            // 1. Safely extract the exact URL from Replicate
            let replicateUrl = "";
            if (typeof output === 'string') replicateUrl = output;
            else if (Array.isArray(output)) replicateUrl = output.find(u => typeof u === 'string' && u.endsWith('.glb')) || output[0];
            else if (typeof output === 'object') replicateUrl = output.model || output.mesh || output.glb || Object.values(output).find(v => typeof v === 'string' && v.startsWith('http'));

            if (!replicateUrl || typeof replicateUrl !== 'string') {
                throw new Error("Could not extract URL from Replicate: " + JSON.stringify(output));
            }

            console.log("Downloading from Replicate CDN...");

            // 2. The Server downloads the file using the Replicate API Token
            const fileResponse = await fetch(replicateUrl, {
                headers: { "Authorization": `Bearer ${process.env.REPLICATE_API_TOKEN}` }
            });

            if (!fileResponse.ok) throw new Error("Failed to download from Replicate.");

            const arrayBuffer = await fileResponse.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // 3. The Server directly saves it to Firebase as a pure GLB file
            const bucket = admin.storage().bucket("3dmosta1001");
            const safeFileName = `${uid}_AI_Gen_${Date.now()}.glb`;
            const file = bucket.file(`models/${safeFileName}`);

            await file.save(buffer, {
                metadata: { contentType: 'model/gltf-binary' } // Forces strict 3D file format
            });

            // 4. Send the secure Firebase URL back to the website
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