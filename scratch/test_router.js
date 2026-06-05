import { RouterLayer } from '../src/layers/RouterLayer.js';

const ctx = {
    enrichedPrompt: 'can u create a docx file on topic deep learning Download the plugings u require it should be in breif',
    indiaContext: '',
    workspaceSnapshot: '',
    workspaceDir: process.cwd()
};

async function test() {
    const router = new RouterLayer();
    await router.process(ctx);
    console.log('Result:', ctx.routeDecision);
    process.exit(0);
}

test();
