import express from 'express';
import path from "node:path";
import { fileURLToPath } from 'node:url';
import { EdgeTTS, Constants } from '@andresaya/edge-tts';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfParseModule = require('pdf-parse');
const PDFParse = pdfParseModule.PDFParse;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize EdgeTTS
const tts = new EdgeTTS();

const app = express();

// ===== CONFIGURATION =====
const CONFIG = {
    // Voice to use for synthesis
    VOICE: 'en-US-AriaNeural',

    // How many chunks to process (null = all chunks)
    // Set to a small number like 5 to test
    MAX_CHUNKS_TO_PROCESS: null,

    // Start from a specific chunk (useful for resuming)
    START_CHUNK: 1,

    // Delay between API calls (in milliseconds)
    DELAY_BETWEEN_CHUNKS: 500,
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
    console.log(`Voice: ${CONFIG.VOICE}`);
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

        const outputFilename = "output.mp3";
        const outputPath = path.join(__dirname, outputFilename);
        const writeStream = fs.createWriteStream(outputPath);

        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < chunksToProcess.length; i++) {
            const chunkNumber = startIdx + i + 1;
            console.log(`\n[${chunkNumber}/${chunks.length}] Processing...`);
            console.log(`Chunk length: ${chunksToProcess[i].length} characters`);

            try {
                const textToConvert = chunksToProcess[i].trim();

                if (!textToConvert || textToConvert.length === 0) {
                    console.log(`⚠ Skipping empty chunk`);
                    continue;
                }

                await tts.synthesize(textToConvert, CONFIG.VOICE, {
                    outputFormat: Constants.OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3
                });

                const buffer = tts.toBuffer();

                if (buffer && buffer.length > 0) {
                    writeStream.write(buffer);
                    successCount++;
                    console.log(`✓ Converted and appended successfully (${buffer.length} bytes)`);
                } else {
                    console.error(`⚠ Failed to get buffer`);
                    failCount++;
                }
            } catch (chunkError) {
                failCount++;
                console.error(`❌ Error synthesizing chunk ${chunkNumber}: ${chunkError.message || 'Unknown error'}`);
            }

            // Delay between chunks to avoid being flagged
            if (i < chunksToProcess.length - 1) {
                await new Promise(resolve => setTimeout(resolve, CONFIG.DELAY_BETWEEN_CHUNKS));
            }
        }

        writeStream.end();

        writeStream.on('finish', () => {
            console.log(`\n✅ ALL DONE!`);
            console.log(`Full audio saved: ${outputPath}`);
            console.log(`Total chunks processed: ${successCount}/${chunksToProcess.length}`);
            if (failCount > 0) console.log(`Failed chunks: ${failCount}`);
        });

    } catch (error) {
        console.error("\nFatal error during conversion:", error);
        console.error("Stack trace:", error.stack);
    }
}

app.listen(3000, () => {
    console.log("Server started on port 3000");
    run();
});