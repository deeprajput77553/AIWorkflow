import fs from 'fs';
import path from 'path';

async function run() {
    let apiKey = '';
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const match = envContent.match(/image\s*=\s*["']?(nvapi-[^"'\s]+)["']?/);
        if (match) {
            apiKey = match[1];
        }
    }

    if (!apiKey) {
        console.error("No API key found in .env");
        return;
    }

    console.log("Calling NVIDIA API with debug output...");
    const url = "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell";
    const payload = {
        "prompt": "A simple red apple on a table",
        "seed": 0,
        "steps": 2
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Accept": "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        console.log("Response status:", response.status);
        const data = await response.json();
        fs.writeFileSync('nvidia_response.json', JSON.stringify(data, null, 2), 'utf-8');
        console.log("Saved full response to nvidia_response.json");
    } catch (err) {
        console.error("Error:", err.message);
    }
}

run();
