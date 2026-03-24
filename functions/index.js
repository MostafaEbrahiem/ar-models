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
        timeoutSeconds: 540,  // 9 full minutes of patience
        memory: "1GiB",       
        cors: true            
    }, 
    async (req, res) => {
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
            // Cleaned up inputs for the 3.1 model specifically
            const output = await replicate.run(
                "tencent/hunyuan-3d-3.1",
                {
                    input: { 
                        image: imageUrl, 
                        enable_pbr: true, // Forces high-quality realistic textures
                        face_count: 500000 
                    }
                }
            );

            // ==========================================
            // 2. THE ULTIMATE "CATCH-ALL" DATA EXTRACTOR
            // ==========================================
            let buffer;

            // Scenario A: Replicate returned the raw Blob/File directly (this caused the '{}' error!)
            if (output && typeof output.arrayBuffer === 'function') {
                console.log("AI returned a file directly! Converting to buffer...");
                const arrayBuffer = await output.arrayBuffer();
                buffer = Buffer.from(arrayBuffer);
            }
            // Scenario B: Replicate returned a Web Stream
            else if (output && typeof output.getReader === 'function') {
                console.log("AI returned a stream! Reading stream...");
                const response = new Response(output);
                const arrayBuffer = await response.arrayBuffer();
                buffer = Buffer.from(arrayBuffer);
            }
            // Scenario C: Replicate returned an array with the raw file inside
            else if (Array.isArray(output) && output[0] && typeof output[0].arrayBuffer === 'function') {
                console.log("AI returned an array with a file! Converting...");
                const arrayBuffer = await output[0].arrayBuffer();
                buffer = Buffer.from(arrayBuffer);
            }
            // Scenario D: Replicate returned a URL (or an object containing the new .url() method)
            else {
                let replicateUrl = "";
                
                if (output && typeof output.url === 'function') {
                    replicateUrl = output.url(); 
                } else if (typeof output === 'string') {
                    replicateUrl = output;
                } else if (Array.isArray(output)) {
                    const firstItem = output[0];
                    if (firstItem && typeof firstItem.url === 'function') replicateUrl = firstItem.url();
                    else if (typeof firstItem === 'string') replicateUrl = firstItem;
                } else if (output && typeof output === 'object') {
                    replicateUrl = output.mesh || output.model || output.glb || output.url;
                }

                if (!replicateUrl || typeof replicateUrl !== 'string') {
                    throw new Error("Could not extract data. AI returned: " + JSON.stringify(output));
                }

                console.log("Found URL! Downloading from Replicate CDN...");
                const fileResponse = await fetch(replicateUrl, {
                    headers: { "Authorization": `Bearer ${process.env.REPLICATE_API_TOKEN}` }
                });

                if (!fileResponse.ok) throw new Error("Failed to download file from Replicate.");

                const arrayBuffer = await fileResponse.arrayBuffer();
                buffer = Buffer.from(arrayBuffer);
            }

            // 3. Server saves directly to Firebase
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
            res.status(500).send({ error: "Server Error: " + error.message });
        }
    }
);