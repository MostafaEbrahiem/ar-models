const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const Replicate = require("replicate");

admin.initializeApp();
const db = admin.firestore();

// ==========================================
// 1. THE PAYPAL WEBHOOK (PROFILES & BILLING)
// ==========================================
exports.paypalWebhook = onRequest(async (req, res) => {
    try {
        const payerEmail = req.body.resource.subscriber.email_address;
        if (!payerEmail) return res.status(400).send("No email found");

        // 1. Upgrade all existing models
        const userModelsQuery = await db.collection("clients").where("userEmail", "==", payerEmail).get();
        const batch = db.batch();
        userModelsQuery.forEach((doc) => {
            batch.update(doc.ref, { maxScans: 1000, isPro: true });
        });
        await batch.commit();

        // 2. Upgrade their User Profile (Give them 10 AI Generations)
        const userProfileQuery = await db.collection("users").where("userEmail", "==", payerEmail).get();
        if (!userProfileQuery.empty) {
            const userDoc = userProfileQuery.docs[0];
            await userDoc.ref.update({ 
                isPro: true, 
                maxScans: 1000,
                aiGenerationsAllowed: 10 // Admin can change this number later!
            });
        }

        return res.status(200).send("Pro Upgrade Successful");
    } catch (error) {
        return res.status(500).send("Internal Server Error");
    }
});

// ==========================================
// 2. THE PRODUCTION AI GENERATOR (WITH LIMITS)
// ==========================================
exports.generate3DModel = onRequest(
    { 
        timeoutSeconds: 540,  
        memory: "1GiB",       
        cors: true            
    }, 
    async (req, res) => {
        try {
            const { imageUrl, uid, userEmail } = req.body;
            
            if (!imageUrl || !uid) {
                return res.status(400).send({ error: "Missing image or User ID." });
            }

            // --- SECURITY CHECK: VERIFY GENERATION LIMITS ---
            const userRef = db.collection("users").doc(uid);
            const userDoc = await userRef.get();
            
            let aiUsed = 0;
            let aiAllowed = 10; // Default 10 for Pro

            if (userDoc.exists) {
                aiUsed = userDoc.data().aiGenerationsUsed || 0;
                aiAllowed = userDoc.data().aiGenerationsAllowed || 10;
                
                if (aiUsed >= aiAllowed) {
                    return res.status(403).send({ error: `Limit Reached: You have used all ${aiAllowed} of your AI generations.` });
                }
            } else {
                // First time generating! Create their profile.
                await userRef.set({
                    userEmail: userEmail || "unknown",
                    uid: uid,
                    isPro: true,
                    aiGenerationsUsed: 0,
                    aiGenerationsAllowed: 10,
                    maxScans: 1000
                });
            }
            // ------------------------------------------------

            console.log("Security cleared. Sending image to AI...");

            const replicate = new Replicate({
                auth: process.env.REPLICATE_API_TOKEN, 
            });

            // --- THE 32MB DIET FIX (OPTIMIZED SETTINGS) ---
            const output = await replicate.run(
                "tencent/hunyuan-3d-3.1",
                {
                    input: { 
                        image: imageUrl, 
                        enable_pbr: true, 
                        face_count: 50000,        // Shrinks model size significantly
                        texture_resolution: 1024  // Shrinks image texture weight
                    }
                }
            );

            // --- THE ULTIMATE "CATCH-ALL" DATA EXTRACTOR ---
            let buffer;
            if (output && typeof output.arrayBuffer === 'function') {
                const arrayBuffer = await output.arrayBuffer();
                buffer = Buffer.from(arrayBuffer);
            }
            else if (output && typeof output.getReader === 'function') {
                const response = new Response(output);
                const arrayBuffer = await response.arrayBuffer();
                buffer = Buffer.from(arrayBuffer);
            }
            else if (Array.isArray(output) && output[0] && typeof output[0].arrayBuffer === 'function') {
                const arrayBuffer = await output[0].arrayBuffer();
                buffer = Buffer.from(arrayBuffer);
            }
            else {
                let replicateUrl = "";
                if (output && typeof output.url === 'function') replicateUrl = output.url(); 
                else if (typeof output === 'string') replicateUrl = output;
                else if (Array.isArray(output)) {
                    const firstItem = output[0];
                    if (firstItem && typeof firstItem.url === 'function') replicateUrl = firstItem.url();
                    else if (typeof firstItem === 'string') replicateUrl = firstItem;
                } else if (output && typeof output === 'object') {
                    replicateUrl = output.mesh || output.model || output.glb || output.url;
                }

                if (!replicateUrl || typeof replicateUrl !== 'string') throw new Error("Could not extract data.");

                const fileResponse = await fetch(replicateUrl, {
                    headers: { "Authorization": `Bearer ${process.env.REPLICATE_API_TOKEN}` }
                });
                if (!fileResponse.ok) throw new Error("Failed to download file.");

                const arrayBuffer = await fileResponse.arrayBuffer();
                buffer = Buffer.from(arrayBuffer);
            }

            // --- SECURE SAVE TO FIREBASE STORAGE ---
            const bucket = admin.storage().bucket("3dmosta1001");
            const safeFileName = `${uid}_AI_Gen_${Date.now()}.glb`;
            const file = bucket.file(`models/${safeFileName}`);

            await file.save(buffer, { metadata: { contentType: 'model/gltf-binary' } });

            const encodedPath = encodeURIComponent(`models/${safeFileName}`);
            const finalFirebaseUrl = `https://firebasestorage.googleapis.com/v0/b/3dmosta1001/o/${encodedPath}?alt=media`;

            // --- SUCCESS! INCREMENT THE USER'S BILLING COUNTER ---
            await userRef.update({
                aiGenerationsUsed: admin.firestore.FieldValue.increment(1)
            });
            // -----------------------------------------------------

            res.status(200).send({ glbUrl: finalFirebaseUrl, fileName: safeFileName });

        } catch (error) {
            console.error("AI Generation Error:", error);
            res.status(500).send({ error: "Server Error: " + error.message });
        }
    }
);