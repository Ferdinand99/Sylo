// Worker thread for pigeonPow.js: solves one proof of work and reports the nonce.
import { parentPort, workerData } from 'node:worker_threads';
import { solvePow } from './pigeonPow.js';

parentPort.postMessage({ nonce: solvePow(workerData.challenge, workerData.difficulty) });
