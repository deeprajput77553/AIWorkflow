import GenerateImage from '../src/plugins/GenerateImage.js';

async function run() {
    console.log("Calling GenerateImage plugin execute...");
    const result = await GenerateImage.execute({
        prompt: "A cybernetic wolf howling at a glowing neon moon"
    }, process.cwd());
    console.log("\nExecution Result:\n", result);
}

run().catch(err => {
    console.error("Error running test:", err);
});
