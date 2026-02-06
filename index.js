import express from 'express';
import path from "node:path";
import { fileURLToPath } from 'node:url';
import { init, getAuthToken } from "@heyputer/puter.js/src/init.cjs";
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfParseModule = require('pdf-parse');
const PDFParse = pdfParseModule.PDFParse;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Puter with your token
let authToken = await getAuthToken();
let puter = init(authToken);

const app = express();

// ===== CONFIGURATION =====
const CONFIG = {
    // Set this to true to use test mode (free, returns sample audio)
    TEST_MODE: false,

    // How many chunks to process (null = all chunks)
    // Set to a small number like 5 to test without using all credits
    MAX_CHUNKS_TO_PROCESS: null,

    // Start from a specific chunk (useful for resuming)
    START_CHUNK: 1,

    // Delay between API calls (in milliseconds)
    DELAY_BETWEEN_CHUNKS: 1000,
};

// --- Clean text helper ---
function cleanText(text) {
    return text
        .replace(/--\s*\d+\s*of\s*\d+\s*--/g, "")
        .replace(/\n\s*\n/g, " ")
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ")
        .replace(/[^\x20-\x7E]/g, " ")
        .trim();
}

async function run() {
    console.log("Running...");
    console.log(`Test Mode: ${CONFIG.TEST_MODE}`);
    console.log(`Max Chunks: ${CONFIG.MAX_CHUNKS_TO_PROCESS || 'All'}`);
    console.log(`Starting from chunk: ${CONFIG.START_CHUNK}`);

    try {
        const bookPath = path.join(__dirname, "book.pdf");

        if (!fs.existsSync(bookPath)) {
            throw new Error(`PDF file not found at: ${bookPath}`);
        }

        const dataBuffer = fs.readFileSync(bookPath);
        console.log(`PDF file loaded: ${dataBuffer.length} bytes`);

        const uint8Array = new Uint8Array(dataBuffer);
        const parser = new PDFParse(uint8Array);
        const result = await parser.getText();
        let fullText = cleanText(result.text);

        console.log(`Full text: ${fullText}`);

        console.log(`Text extracted successfully. Clean length: ${fullText.length} characters.`);

        if (fullText.length === 0) {
            throw new Error("No text extracted from PDF");
        }

        // --- Chunking ---
        const MAX_CHUNK_SIZE = 2900;
        const chunks = [];
        let pos = 0;

        while (pos < fullText.length) {
            let end = pos + MAX_CHUNK_SIZE;
            if (end < fullText.length) {
                let boundary = fullText.lastIndexOf(". ", end);
                if (boundary === -1 || boundary <= pos) {
                    boundary = fullText.lastIndexOf(" ", end);
                }
                if (boundary > pos) end = boundary + 1;
            }
            const chunk = fullText.substring(pos, end).trim();
            if (chunk.length > 0) {
                chunks.push(chunk);
            }
            pos = end;
        }

        console.log(`Total chunks created: ${chunks.length}`);

        // Determine which chunks to process
        const startIdx = CONFIG.START_CHUNK - 1;
        const endIdx = CONFIG.MAX_CHUNKS_TO_PROCESS
            ? Math.min(startIdx + CONFIG.MAX_CHUNKS_TO_PROCESS, chunks.length)
            : chunks.length;

        const chunksToProcess = chunks.slice(startIdx, endIdx);
        console.log(`Processing chunks ${CONFIG.START_CHUNK} to ${startIdx + chunksToProcess.length}...`);

        const audioBuffers = [];
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < chunksToProcess.length; i++) {
            const chunkNumber = startIdx + i + 1;
            console.log(`\n[${chunkNumber}/${chunks.length}] Processing...`);
            console.log(`Chunk length: ${chunksToProcess[i].length} characters`);
            console.log(`Preview: ${chunksToProcess[i].slice(0, 80)}...`);

            try {
                const textToConvert = chunksToProcess[i].trim();

                if (!textToConvert || textToConvert.length === 0) {
                    console.log(`⚠ Skipping empty chunk`);
                    continue;
                }

                if (textToConvert.length > 3000) {
                    console.error(`⚠ Chunk exceeds 3000 character limit, skipping`);
                    failCount++;
                    continue;
                }

                const audioElement = await puter.ai.txt2speech(textToConvert);

                console.log(`Audio element received`);

                const response = await fetch(audioElement.src);
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);

                if (buffer && buffer.length > 0) {
                    audioBuffers.push(buffer);
                    successCount++;
                    console.log(`✓ Converted successfully (${buffer.length} bytes)`);
                } else {
                    console.error(`⚠ Failed to get buffer`);
                    failCount++;
                }
            } catch (chunkError) {
                failCount++;

                // Check if it's an insufficient funds error
                if (chunkError.error && chunkError.error.code === 'insufficient_funds') {
                    console.error(`❌ INSUFFICIENT FUNDS - Stopping process`);
                    console.error(`Successfully processed: ${successCount} chunks`);
                    console.error(`Failed: ${failCount} chunks`);
                    console.error(`\nTo continue, please:`);
                    console.error(`1. Add credits to your Puter account, OR`);
                    console.error(`2. Set TEST_MODE: true in CONFIG (for testing), OR`);
                    console.error(`3. Set MAX_CHUNKS_TO_PROCESS to a lower number`);
                    break; // Stop processing
                }

                console.error(`❌ Error: ${chunkError.message || 'Unknown error'}`);
                if (chunkError.error) {
                    console.error("Error details:", chunkError.error);
                }
            }

            // Delay between chunks
            if (i < chunksToProcess.length - 1) {
                await new Promise(resolve => setTimeout(resolve, CONFIG.DELAY_BETWEEN_CHUNKS));
            }
        }

        // --- Combine chunks ---
        if (audioBuffers.length > 0) {
            const finalBuffer = Buffer.concat(audioBuffers);
            const outputFilename = CONFIG.TEST_MODE ? "output-test.mp3" : "output.mp3";
            const outputPath = path.join(__dirname, outputFilename);
            fs.writeFileSync(outputPath, finalBuffer);

            console.log(`\n✅ SUCCESS!`);
            console.log(`File saved: ${outputPath}`);
            console.log(`Total size: ${(finalBuffer.length / 1024 / 1024).toFixed(2)} MB`);
            console.log(`Chunks processed: ${successCount}/${chunksToProcess.length}`);
            console.log(`Failed chunks: ${failCount}`);
        } else {
            console.error("\n❌ No audio buffers were created");
        }

    } catch (error) {
        console.error("\nFatal error during conversion:", error);
        console.error("Stack trace:", error.stack);
    }
}

app.listen(3000, () => {
    console.log("Server started on port 3000");
    run();
});