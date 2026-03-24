const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

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
// 2. THE DUMMY SWITCH TEST (INSTANT & FREE)
// ==========================================
exports.generate3DModel = onRequest(
    { 
        timeoutSeconds: 540,  // BOOSTED TO 9 MINUTES to prevent future timeouts!
        memory: "1GiB",       
        cors: true            
    }, 
    async (req, res) => {
        // Bulletproof header injection just in case of future timeouts
        res.set('Access-Control-Allow-Origin', '*');

        try {
            const { imageUrl, uid } = req.body;
            
            if (!imageUrl || !uid) {
                return res.status(400).send({ error: "Missing image or User ID." });
            }

            console.log("TEST MODE: Bypassing Replicate to test Firebase Storage...");

            // 1. THE FREE DUMMY DUCK URL
            // This skips the AI generation wait time so we can test the plumbing instantly.
            const replicateUrl = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/Duck/glTF-Binary/Duck.glb";

            console.log("Downloading Dummy Duck...");

            // 2. Server downloads the file
            const fileResponse = await fetch(replicateUrl);
            if (!fileResponse.ok) throw new Error("Failed to download dummy file.");

            const arrayBuffer = await fileResponse.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // 3. Server saves directly to your Firebase Storage as a pure GLB
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