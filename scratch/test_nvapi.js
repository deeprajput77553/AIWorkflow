import fs from 'fs';
import path from 'path';
import { runTerminal } from '../src/layers/ExecutionLayer.js';

// Read API key
let apiKey = '';
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const match = envContent.match(/image\s*=\s*["']?(nvapi-[^"'\s]+)["']?/);
    if (match) {
        apiKey = match[1];
    }
}

console.log("NVIDIA API Key found:", apiKey ? "YES (starts with nvapi-)" : "NO");

if (apiKey) {
    // Generate a simple test DB
    const testDb = {
      originalPrompt: "NVIDIA Image API Verification",
      format: "docx",
      filename: "NVIDIA_Verification.docx",
      nvidia_api_key: apiKey,
      topics: [
        {
          title: "Test Section",
          content: "This section contains a generated concept diagram.",
          image_prompt: "Vibrant premium 3D infographic illustration of deep learning applications. Symmetrical technology layout on a clean light gray background. In the center, a glowing blue digital brain icon inside a glossy sphere. Connected by glowing blue data paths are five surrounding colorful 3D nodes, each node containing a detailed, clearly visible glossy icon: a blue camera lens (vision), a green speech bubble (NLP), a yellow microphone (speech), a red shopping cart (recommendations), and a purple shield (security). Bright studio lighting, smooth gradients, soft reflections, professional tech design, no text."
        }
      ]
    };
    
    fs.writeFileSync('temp_topics.json', JSON.stringify(testDb, null, 2), 'utf-8');
    
    // Copy compile_doc.py script content from ExecutionLayer.js
    const elContent = fs.readFileSync('src/layers/ExecutionLayer.js', 'utf-8');
    // Extract the compiler script using regex
    const matchScript = elContent.match(/const compilerScript = `([\s\S]*?)`;/);
    if (matchScript) {
        fs.writeFileSync('compile_doc.py', matchScript[1], 'utf-8');
        console.log("Running compile_doc.py to test image generation...");
        const res = runTerminal('python compile_doc.py', process.cwd());
        console.log("Exit code:", res.code);
        console.log("Stdout:", res.stdout);
        console.log("Stderr:", res.stderr);
    } else {
        console.log("Failed to extract compilerScript from ExecutionLayer.js");
    }
    
    // Cleanup
    try {
        if (fs.existsSync('temp_topics.json')) fs.unlinkSync('temp_topics.json');
        if (fs.existsSync('compile_doc.py')) fs.unlinkSync('compile_doc.py');
    } catch {}
} else {
    console.log("Skipping image generation test (no API key).");
}
