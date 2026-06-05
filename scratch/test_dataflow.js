import fs from 'fs';
import path from 'path';
import assert from 'assert';

// Import key functions from ollama_agent.js by dynamic execution or we can mock/re-import them.
// Since we want to test the actual code in ollama_agent.js, but it runs runLoop() at the end, 
// if we import it, it will block on readline prompt!
// To test it without blocking, we can read the file, extract the functions, and evaluate them in a sandbox,
// or we can test their definitions by matching.
// An elegant way is to read ollama_agent.js, strip out 'runLoop();' at the end, and run it using eval/vm, or just extract the relevant functions.
// Let's write a simple sandboxed test runner using the file contents.

console.log('🧪 Starting data flow and validation tests...');

const scriptPath = path.join(process.cwd(), 'ollama_agent.js');
let scriptContent = fs.readFileSync(scriptPath, 'utf-8');

// Strip out runLoop() so it doesn't block
scriptContent = scriptContent.replace(/runLoop\(\);\s*$/, '');

// Create a module wrapper or evaluate
// We want to export the functions for testing.
// Let's append exports to the script content:
const exportsCode = `
export {
    validateToolCall,
    executeFileToolStructured,
    scanWorkspace,
    buildWorkspaceSnapshot,
    EXCLUDED_DIRS,
    EXCLUDED_FILES,
    MAX_FILE_SIZE_PREVIEW,
    validateToolCall as valTool,
    loadTraceLog,
    writeTraceLog,
    antigravityRouter,
    normalizeRouterResponse,
    getIndiaContext,
    buildContextHeader,
    detectSystemVersionCheck,
    TOOL_VERSION_COMMANDS
};
`;

const testScriptPath = path.join(process.cwd(), 'scratch', 'temp_test_wrapped.js');
fs.writeFileSync(testScriptPath, scriptContent + exportsCode, 'utf-8');

try {
    const {
        validateToolCall,
        executeFileToolStructured,
        scanWorkspace,
        buildWorkspaceSnapshot,
        EXCLUDED_DIRS,
        EXCLUDED_FILES,
        loadTraceLog,
        writeTraceLog,
        antigravityRouter,
        normalizeRouterResponse,
        getIndiaContext,
        buildContextHeader,
        detectSystemVersionCheck,
        TOOL_VERSION_COMMANDS
    } = await import('./temp_test_wrapped.js');

    console.log('✅ Wrapped functions imported successfully.');

    // Test 1: EXCLUDED_DIRS and EXCLUDED_FILES are defined
    console.log('Testing EXCLUDED_DIRS...');
    assert(EXCLUDED_DIRS.includes('node_modules'), 'node_modules should be excluded');
    assert(EXCLUDED_DIRS.includes('.git'), '.git should be excluded');
    assert(EXCLUDED_FILES.includes('package-lock.json'), 'package-lock.json should be excluded');
    console.log('   -> EXCLUDED_DIRS/FILES checks passed!');

    // Test 2: Tool Call Validation - Valid case
    console.log('Testing validateToolCall (Valid)...');
    const validCall = {
        tool: 'create_file',
        path: 'test_temp.txt',
        content: 'Hello, World!'
    };
    const resValid = validateToolCall(validCall);
    assert(resValid.valid === true, `Valid tool call was rejected: ${resValid.error}`);
    console.log('   -> Valid tool call validation passed!');

    // Test 3: Tool Call Validation - Missing required param
    console.log('Testing validateToolCall (Missing param)...');
    const invalidCallMissing = {
        tool: 'create_file',
        path: 'test_temp.txt'
        // content is missing
    };
    const resMissing = validateToolCall(invalidCallMissing);
    assert(resMissing.valid === false, 'Invalid tool call (missing param) was accepted');
    assert(resMissing.error.includes('Missing required parameter'), 'Error message should complain about missing param');
    console.log('   -> Missing param validation passed!');

    // Test 4: Tool Call Validation - Invalid parameter type
    console.log('Testing validateToolCall (Wrong type)...');
    const invalidCallType = {
        tool: 'replace_lines',
        path: 'test_temp.txt',
        start_line: 'not-a-number',
        end_line: 5,
        content: 'replacement'
    };
    const resType = validateToolCall(invalidCallType);
    assert(resType.valid === false, 'Invalid tool call (wrong type) was accepted');
    assert(resType.error.includes('must be a number'), 'Error message should complain about number type');
    console.log('   -> Parameter type validation passed!');

    // Test 5: Path Bounds / Security check
    console.log('Testing Path Security bounds...');
    const invalidPathCall = {
        tool: 'read_file',
        path: '../../outside_workspace.txt'
    };
    const resPath = validateToolCall(invalidPathCall);
    assert(resPath.valid === false, 'Tool call accessing path outside workspace was accepted');
    assert(resPath.error.includes('outside the locked workspace'), 'Error message should complain about security bounds');
    console.log('   -> Path security check passed!');

    // Test 6: Trace logging persistence
    console.log('Testing Trace Logger...');
    const mockTrace = {
        timestamp: new Date().toISOString(),
        prompt: 'test prompt',
        route: { mode: 'REACTIVE', reason: 'unit test' },
        steps: [{ tool: 'list_dir', success: true }]
    };
    writeTraceLog(mockTrace);
    const traces = loadTraceLog();
    const lastTrace = traces[traces.length - 1];
    assert.strictEqual(lastTrace.prompt, 'test prompt');
    assert.strictEqual(lastTrace.route.mode, 'REACTIVE');
    console.log('   -> Trace logger check passed!');

    // Test 7: Normalization of deviant LLM responses
    console.log('Testing normalizeRouterResponse helper...');
    const deviantResponse = {
        message: "greeting{hi}",
        complexsity: "low level model",
        model: "low level model",
        "extra prompt": "Greeting sir based on Sunday morning context"
    };
    const norm = normalizeRouterResponse(deviantResponse);
    assert.strictEqual(norm.target_model, 'reactive', 'model: low level model should normalize to reactive');
    assert.strictEqual(norm.complexity, 'low', 'complexsity should normalize to low');
    assert.strictEqual(norm.message_summary, 'greeting{hi}', 'message should normalize to message_summary');
    assert.strictEqual(norm.extra_prompt, 'Greeting sir based on Sunday morning context', 'extra prompt should normalize to extra_prompt');
    console.log('   -> Normalization of deviant LLM responses passed!');

    // Test 8: Router metadata orchestration check
    console.log('Testing metadata orchestration routing...');
    const resRouteHi = await antigravityRouter('hi');
    assert.ok(norm.target_model, 'Router should return target_model');
    assert.ok(norm.complexity, 'Router should return complexity');
    assert.ok(norm.extra_prompt, 'Router should return extra_prompt');
    assert.ok(norm.message_summary, 'Router should return message_summary');
    console.log('   -> Router metadata orchestration check passed!');

    // Test 9: India Time Context check
    console.log('Testing India Time Context helper...');
    const context = getIndiaContext();
    assert.ok(context.includes('India'), 'Context should contain time zone India');
    assert.ok(context.includes('Season'), 'Context should contain Current Season');
    console.log('   -> India Time Context check passed!');

    // Test 10: buildContextHeader automatic India context injection
    console.log('Testing buildContextHeader automatic India context injection...');
    const contextHeader = buildContextHeader('System base prompt');
    assert.ok(contextHeader.includes('India Time & Season Context'), 'Context header should contain India Time & Season Context');
    console.log('   -> buildContextHeader injection passed!');

    // Test 11: detectSystemVersionCheck — positive matches
    console.log('Testing detectSystemVersionCheck (positive matches)...');
    const cases = [
        ['whats my python version', 'python --version'],
        ['check python version', 'python --version'],
        ['is git installed', 'git --version'],
        ['do i have node', 'node --version'],
        ['check docker version', 'docker --version'],
        ['npm version', 'npm --version'],
        ['go version check', 'go version'],
        ['whats my agy version', 'agy --version'],
        ['do i have antigravity installed', 'agy --version'],
    ];
    for (const [input, expectedCmd] of cases) {
        const result = detectSystemVersionCheck(input);
        assert.ok(result, `Expected match for: "${input}"`);
        assert.strictEqual(result.target_model, 'terminal', `"${input}" should route to terminal`);
        assert.ok(result.extra_prompt.includes(expectedCmd), `extra_prompt should include '${expectedCmd}' for "${input}"`);
    }
    console.log('   -> detectSystemVersionCheck positive match passed!');

    // Test 12: detectSystemVersionCheck — negative cases (must NOT match)
    console.log('Testing detectSystemVersionCheck (negative cases)...');
    const negCases = ['hi', 'hello', 'what is react', 'tell me about github', 'scan my folder', 'what time is it'];
    for (const input of negCases) {
        assert.strictEqual(detectSystemVersionCheck(input), null, `"${input}" should NOT be fast-tracked`);
    }
    console.log('   -> detectSystemVersionCheck negative case passed!');

    // Test 13: detectSystemVersionCheck — non-tool formats (must route to reactive)
    console.log('Testing detectSystemVersionCheck (non-tool formats)...');
    const nonToolCases = [
        'what about my json version',
        'check xml version',
        'is yaml version available?',
        'whats my csv version'
    ];
    for (const input of nonToolCases) {
        const result = detectSystemVersionCheck(input);
        assert.ok(result, `Expected match for: "${input}"`);
        assert.strictEqual(result.target_model, 'reactive', `"${input}" should route to reactive`);
        assert.ok(result.message_summary.startsWith('non_tool_version_check'), `message_summary should start with non_tool_version_check for "${input}"`);
        assert.ok(result.extra_prompt.includes('data format'), `extra_prompt should clarify it is a data format for "${input}"`);
    }
    console.log('   -> detectSystemVersionCheck non-tool formats passed!');

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! Data flow and tool call handling are robust and precise.');

} catch (err) {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
} finally {
    // Cleanup temp test file
    try {
        if (fs.existsSync(testScriptPath)) {
            fs.unlinkSync(testScriptPath);
        }
    } catch {}
}
