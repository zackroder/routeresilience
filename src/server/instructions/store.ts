import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CreateInstructionInput, InstructionStatus, OperatorInstruction } from './types.js';

const SENT_TTL_MS = 15 * 60 * 1000; // SENT instructions expire if not acknowledged
const RECENT_WINDOW_MS = 24 * 3600 * 1000;

/**
 * In-memory store for operator instructions, persisted to JSON.
 * Follows the DetourStore/CancellationStore pattern (single-process, sync reads).
 * Expiration is evaluated at read time (no background timers).
 */
export class InstructionStore {
    private instructions = new Map<string, OperatorInstruction>();

    private readonly storeDir = process.env.PERSISTENT_DATA_DIR || path.resolve(process.cwd(), 'data');
    private readonly storePath = path.join(this.storeDir, 'instructions.json');

    constructor() {
        this.load();
    }

    private load(): void {
        try {
            if (fs.existsSync(this.storePath)) {
                const data = fs.readFileSync(this.storePath, 'utf-8');
                const array: OperatorInstruction[] = JSON.parse(data);
                for (const inst of array) {
                    this.instructions.set(inst.id, inst);
                }
                console.log(`Loaded ${this.instructions.size} instructions from disk`);
            }
        } catch (e) {
            console.error('Failed to load instructions from disk:', e);
        }
    }

    private async save(): Promise<void> {
        try {
            if (!fs.existsSync(this.storeDir)) {
                await fs.promises.mkdir(this.storeDir, { recursive: true });
            }
            const data = JSON.stringify(Array.from(this.instructions.values()), null, 2);
            await fs.promises.writeFile(this.storePath, data, 'utf-8');
        } catch (e) {
            console.error('Failed to save instructions to disk:', e);
        }
    }

    create(input: CreateInstructionInput): OperatorInstruction {
        const now = Date.now();
        const instruction: OperatorInstruction = {
            ...input,
            id: `inst_${crypto.randomUUID()}`,
            status: 'SENT',
            createdAt: now,
            acknowledgedAt: null,
            completedAt: null,
            cancelledAt: null,
            expiresAt: now + SENT_TTL_MS,
        };
        this.instructions.set(instruction.id, instruction);
        this.save();
        return instruction;
    }

    get(id: string): OperatorInstruction | undefined {
        return this.instructions.get(id);
    }

    listAll(): OperatorInstruction[] {
        return Array.from(this.instructions.values())
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    /** Instructions still needing operator/dispatcher attention (SENT or ACKNOWLEDGED). */
    listActive(now: number = Date.now()): OperatorInstruction[] {
        this.expireSent(now);
        return this.listAll().filter(i => i.status === 'SENT' || i.status === 'ACKNOWLEDGED');
    }

    /** Instructions from the recent window (for the dashboard history). */
    listRecent(now: number = Date.now()): OperatorInstruction[] {
        return this.listAll().filter(i => now - i.createdAt <= RECENT_WINDOW_MS);
    }

    acknowledge(id: string, now: number = Date.now()): OperatorInstruction | undefined {
        const inst = this.instructions.get(id);
        if (!inst) return undefined;
        if (inst.status === 'COMPLETED' || inst.status === 'CANCELLED') return inst;
        inst.status = 'ACKNOWLEDGED';
        inst.acknowledgedAt = now;
        this.save();
        return inst;
    }

    complete(id: string, now: number = Date.now()): OperatorInstruction | undefined {
        const inst = this.instructions.get(id);
        if (!inst) return undefined;
        inst.status = 'COMPLETED';
        inst.completedAt = now;
        this.save();
        return inst;
    }

    cancel(id: string, now: number = Date.now()): OperatorInstruction | undefined {
        const inst = this.instructions.get(id);
        if (!inst) return undefined;
        inst.status = 'CANCELLED';
        inst.cancelledAt = now;
        this.save();
        return inst;
    }

    private expireSent(now: number): void {
        let changed = false;
        for (const inst of this.instructions.values()) {
            if (inst.status === 'SENT' && now > inst.expiresAt) {
                inst.status = 'EXPIRED' as InstructionStatus;
                changed = true;
            }
        }
        if (changed) this.save();
    }
}
