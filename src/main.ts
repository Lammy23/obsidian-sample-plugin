import { App, Plugin, PluginSettingTab, Setting, Modal, Notice, TFile, MarkdownRenderer, setIcon } from 'obsidian';

// --- SETTINGS DEFINITION ---
interface CanvasPlayerSettings {
    showDebugState: boolean;
}

const DEFAULT_SETTINGS: CanvasPlayerSettings = {
    showDebugState: false
}

// --- LOGIC ENGINE V2 (TURING COMPLETE) ---

function getSafeVars(expression: string): string[] {
    const noStrings = expression.replace(/(['"]).*?\1/g, '');
    const words = noStrings.match(/[a-zA-Z_]\w*/g) || [];
    const vars = new Set(words);
    ['true', 'false', 'null', 'undefined', 'Math', 'Number', 'String'].forEach(w => vars.delete(w));
    return Array.from(vars);
}

function evaluateCondition(label: string, state: Record<string, any>): boolean {
    const match = label.match(/\?{([^}]+)}/);
    if (!match) return true;

    const condition = match[1];
    const safeVars = getSafeVars(condition);

    let context = "";
    safeVars.forEach(v => {
        context += `let ${v} = typeof state.${v} !== 'undefined' ? state.${v} : 0;\n`;
    });

    try {
        const func = new Function('state', `${context} return ${condition};`);
        return !!func(state);
    } catch (e) {
        return false;
    }
}

function applyStateChanges(label: string, state: Record<string, any>) {
    const match = label.match(/!{([^}]+)}/);
    if (!match) return;

    const action = match[1];
    const safeVars = getSafeVars(action);

    let setup = "";
    let teardown = "";
    safeVars.forEach(v => {
        setup += `let ${v} = typeof state.${v} !== 'undefined' ? state.${v} : 0;\n`;
        teardown += `state.${v} = ${v};\n`;
    });

    try {
        const func = new Function('state', `${setup} ${action};\n ${teardown}`);
        func(state);
    } catch (e) {
        console.warn(`Canvas Player: Failed to execute action: ${action}`, e);
    }
}

function cleanLabelText(label: string): string {
    return label.replace(/\?{[^}]+}/g, '').replace(/!{[^}]+}/g, '').trim() || "Next Step";
}


// --- THE FULLSCREEN MODAL PLAYER ---
class CanvasPlayerModal extends Modal {
    private canvasData: any;
    private currentFile: TFile;
    private plugin: CanvasPlayerPlugin;

    private currentNodeId: string | null = null;
    private flowState: Record<string, any> = {};
    private callStack: Array<{ file: TFile, canvasData: any, returnNodeId: string }> = [];

    private skipCounter: number = 0;

    constructor(app: App, plugin: CanvasPlayerPlugin, file: TFile, data: string, savedSession: any) {
        super(app);
        this.plugin = plugin;
        this.currentFile = file;
        this.canvasData = JSON.parse(data);

        if (savedSession) {
            this.currentNodeId = savedSession.currentNodeId;
            this.flowState = savedSession.flowState;
            this.callStack = savedSession.callStack || [];
        }

        // UI FIX: Override Obsidian's default modal sizing to make it truly fullscreen edge-to-edge
        this.modalEl.style.width = "100vw";
        this.modalEl.style.height = "100vh";
        this.modalEl.style.maxWidth = "none";
        this.modalEl.style.maxHeight = "none";
        this.modalEl.style.borderRadius = "0";
        this.modalEl.style.border = "none";
        this.modalEl.style.boxShadow = "none";

        // UI FIX: Force a blur and dark background overlay to completely obscure the canvas beneath
        this.containerEl.style.backdropFilter = "blur(15px)";
        this.containerEl.style.webkitBackdropFilter = "blur(15px)";
        this.containerEl.style.backgroundColor = "rgba(0, 0, 0, 0.4)";
    }

    onOpen() {
        // const restartBtn = this.modalEl.createEl("button", {
        //     cls: "clickable-icon",
        //     attr: { style: "position: absolute; top: 12px; left: 12px; height: 32px; width: 32px; display: flex; align-items: center; justify-content: center; background: transparent; box-shadow: none; border: none;", "aria-label": "Restart Algorithm" }
        // });
        const restartBtn = this.modalEl.createEl("button", {
            cls: ["clickable-icon", 'modal-close-button'],
            attr: { style: "position: absolute; top: 12px; left: 12px; height: 32px; width: 32px; display: flex; align-items: center; justify-content: center;", "aria-label": "Restart Algorithm" }
        });
        setIcon(restartBtn, 'rotate-ccw');

        restartBtn.onclick = () => {
            const startNode = this.canvasData.nodes.find((n: any) => n.text === "canvas-start");
            if (startNode) {
                this.flowState = {};
                this.callStack = [];
                this.currentNodeId = startNode.id;
                this.skipCounter = 0;
                delete this.plugin.playbackSessions[this.currentFile.path];
                this.renderStep();
            }
        };

        if (!this.currentNodeId) {
            const startNode = this.canvasData.nodes.find((n: any) => n.text === "canvas-start");
            if (!startNode) {
                new Notice("Could not find a node with text 'canvas-start'");
                this.close();
                return;
            }

            const startEdges = this.canvasData.edges.filter((e: any) => e.fromNode === startNode.id);
            if (startEdges.length === 0) {
                new Notice("⚠️ Warning: 'canvas-start' is not connected to anything!");
            }

            this.currentNodeId = startNode.id;
        }

        this.renderStep();
    }

    onClose() {
        this.contentEl.empty();
    }

    private saveProgress() {
        if (this.currentNodeId) {
            this.plugin.playbackSessions[this.currentFile.path] = {
                currentNodeId: this.currentNodeId,
                flowState: { ...this.flowState },
                callStack: [...this.callStack]
            };
        }
    }

    private async renderStep() {
        this.contentEl.empty();

        // --- INJECT RESPONSIVE CSS ---
        this.contentEl.createEl("style", {
            text: `
            .canvas-player-container {
                display: flex;
                flex-direction: column;
                height: 100%;
                width: 100%;
                box-sizing: border-box;
                padding: 20px 10px;
                overflow-y: auto;
            }
            .canvas-player-content {
                font-size: 1.3em;
                line-height: 1.6;
                margin-bottom: 40px;
                text-align: left;
                width: 100%;
                max-width: 600px;
                margin-left: auto;
                margin-right: auto;
            }
            .canvas-player-controls {
                display: flex;
                flex-direction: column;
                gap: 15px;
                width: 100%;
                max-width: 400px;
                margin: 0 auto;
            }
            @media (min-width: 768px) {
                .canvas-player-container {
                    flex-direction: row;
                    align-items: center;
                    justify-content: center;
                    gap: 60px;
                    padding: 40px;
                    overflow: hidden;
                }
                .canvas-player-content {
                    flex: 1;
                    margin: 0;
                    overflow-y: auto;
                    max-height: 100%;
                    padding-right: 20px;
                    max-width: 800px;
                }
                .canvas-player-controls {
                    width: 400px;
                    flex-shrink: 0;
                    margin: 0;
                    max-height: 100%;
                    overflow-y: auto;
                    padding-right: 10px;
                }
            }
            `
        });

        if (!this.currentNodeId || !this.canvasData || !this.currentFile) return;

        const node = this.canvasData.nodes.find((n: any) => n.id === this.currentNodeId);
        if (!node) return;

        const allOutgoingEdges = this.canvasData.edges.filter((e: any) => e.fromNode === this.currentNodeId);
        const validEdgesForDummy = allOutgoingEdges.filter((edge: any) => evaluateCondition(edge.label || "", this.flowState));

        // --- INVISIBLE DUMMY & CANVAS-START SKIP ---
        const isStartNode = node.text.trim() === "canvas-start";
        if ((!node.text.trim() || isStartNode) && validEdgesForDummy.length > 0) {

            if (this.skipCounter > 50) {
                new Notice("⚠️ Infinite Loop Detected: Over 50 empty/start nodes skipped instantly.");
                this.skipCounter = 0;
                return;
            }

            this.skipCounter++;
            const edge = validEdgesForDummy[0];
            applyStateChanges(edge.label || "", this.flowState);
            this.currentNodeId = edge.toNode;
            this.saveProgress();
            setTimeout(() => this.renderStep(), 0);
            return;
        }

        this.skipCounter = 0;

        // --- NESTED SUBGRAPH LOADER ---
        const linkMatch = node.text.trim().match(/^\[\[(.*?)\]\]$/);
        if (linkMatch && validEdgesForDummy.length > 0) {
            const linkText = linkMatch[1];
            const targetFile = this.app.metadataCache.getFirstLinkpathDest(linkText, this.currentFile.path);

            if (targetFile && targetFile.extension === 'canvas') {
                const targetData = await this.app.vault.read(targetFile);
                const parsedTargetData = JSON.parse(targetData);
                const startNode = parsedTargetData.nodes.find((n: any) => n.text === "canvas-start");

                if (startNode) {
                    this.callStack.push({
                        file: this.currentFile,
                        canvasData: this.canvasData,
                        returnNodeId: validEdgesForDummy[0].toNode
                    });

                    this.currentFile = targetFile;
                    this.canvasData = parsedTargetData;
                    this.currentNodeId = startNode.id;

                    setTimeout(() => this.renderStep(), 0);
                    return;
                }
            }
        }

        // --- RESPONSIVE LAYOUT CONTAINERS ---
        const container = this.contentEl.createEl("div", { cls: "canvas-player-container" });
        const contentDiv = container.createEl("div", { cls: "canvas-player-content" });
        const controlsDiv = container.createEl("div", { cls: "canvas-player-controls" });

        // --- TYPO CATCHER WARNING UI ---
        let missingVars = new Set<string>();
        allOutgoingEdges.forEach((edge: any) => {
            const conditionMatch = (edge.label || "").match(/\?{([^}]+)}/);
            if (conditionMatch) {
                getSafeVars(conditionMatch[1]).forEach(v => {
                    if (!(v in this.flowState)) missingVars.add(v);
                });
            }
        });

        if (missingVars.size > 0 && this.plugin.settings.showDebugState) {
            contentDiv.createEl("div", {
                text: `⚠️ Engine Note: Edges are checking variables that haven't been set yet: [${Array.from(missingVars).join(", ")}]. They will default to 0.`,
                attr: { style: "margin-bottom: 20px; font-weight: bold; font-size: 0.9em; color: var(--text-on-accent); background: var(--color-orange); padding: 12px; border-radius: 6px; width: 100%; text-align: left;" }
            });
        }

        // --- USER TEXT INPUT EXTRACTION ---
        const rawText = node.text || "";
        const inputRegex = /#{\s*([a-zA-Z_]\w*)\s*}/g;
        const inputVars = new Set<string>();
        let match;
        while ((match = inputRegex.exec(rawText)) !== null) {
            inputVars.add(match[1]);
        }

        const cleanText = rawText.replace(/#{\s*[a-zA-Z_]\w*\s*}/g, '').trim();

        await MarkdownRenderer.renderMarkdown(cleanText, contentDiv, this.currentFile.path, this);

        // --- RENDER DYNAMIC INPUTS ---
        if (inputVars.size > 0) {
            const inputsDiv = controlsDiv.createEl("div", { attr: { style: "display: flex; flex-direction: column; gap: 12px; width: 100%; margin-bottom: 10px; box-sizing: border-box;" } });

            inputVars.forEach(varName => {
                const wrapper = inputsDiv.createEl("div", { attr: { style: "display: flex; flex-direction: column; text-align: left; width: 100%; box-sizing: border-box;" } });
                wrapper.createEl("label", { text: varName, attr: { style: "font-size: 0.9em; color: var(--text-muted); margin-bottom: 6px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;" } });

                const input = wrapper.createEl("input", {
                    type: "text",
                    attr: {
                        placeholder: `Enter value...`,
                        enterkeyhint: "done",
                        style: "width: 100%; box-sizing: border-box; padding: 12px; border-radius: 6px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); color: var(--text-normal); font-size: 1.1em;"
                    }
                });

                if (this.flowState[varName] !== undefined) {
                    input.value = String(this.flowState[varName]);
                }

                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        input.blur();
                    }
                });

                input.addEventListener('input', (e) => {
                    const val = (e.target as HTMLInputElement).value;
                    const numVal = Number(val);
                    this.flowState[varName] = (val.trim() !== "" && !isNaN(numVal)) ? numVal : val;
                    refreshUI();
                });
            });
        }

        const buttonContainer = controlsDiv.createEl("div", { attr: { style: "display: flex; flex-direction: column; gap: 15px; width: 100%; box-sizing: border-box;" } });
        const debugContainer = controlsDiv.createEl("div", { attr: { style: "width: 100%; box-sizing: border-box;" } });

        // --- REACTIVE UI REFRESH FUNCTION ---
        const refreshUI = () => {
            buttonContainer.empty();
            debugContainer.empty();

            const validEdges = allOutgoingEdges.filter((edge: any) => evaluateCondition(edge.label || "", this.flowState));

            if (validEdges.length === 0) {
                if (this.callStack.length > 0) {
                    const parentContext = this.callStack[this.callStack.length - 1];
                    const returnBtn = buttonContainer.createEl("button", {
                        text: "Return to Parent Protocol ⤴",
                        // UI FIX: Stripped accent colors to default to standard Obsidian buttons
                        attr: { style: "width: 100%; box-sizing: border-box; padding: 15px; cursor: pointer; font-weight: 600; font-size: 1.1em; border-radius: 8px;" }
                    });
                    returnBtn.onclick = () => {
                        this.callStack.pop();
                        this.currentFile = parentContext.file;
                        this.canvasData = parentContext.canvasData;
                        this.currentNodeId = parentContext.returnNodeId;
                        this.saveProgress();
                        this.renderStep();
                    };
                } else if (inputVars.size > 0) {
                    buttonContainer.createEl("p", { text: "Waiting for valid input...", attr: { style: "color: var(--text-muted); font-style: italic; margin-top: 10px; text-align: center;" } });
                } else {
                    const finalRestartBtn = buttonContainer.createEl("button", {
                        text: "↻ Restart Protocol",
                        // UI FIX: Using default Obsidian button styling
                        attr: { style: "width: 100%; box-sizing: border-box; padding: 15px; cursor: pointer; font-weight: 600; font-size: 1.1em; border-radius: 8px; margin-top: 10px;" }
                    });
                    finalRestartBtn.onclick = () => {
                        const startNode = this.canvasData.nodes.find((n: any) => n.text === "canvas-start");
                        if (startNode) {
                            this.flowState = {};
                            this.callStack = [];
                            this.currentNodeId = startNode.id;
                            this.skipCounter = 0;
                            delete this.plugin.playbackSessions[this.currentFile.path];
                            this.renderStep();
                        }
                    };
                }
            } else {
                validEdges.forEach((edge: any) => {
                    const rawLabel = edge.label || "";
                    const btn = buttonContainer.createEl("button", {
                        text: cleanLabelText(rawLabel),
                        // UI FIX: Removed var(--interactive-accent) to let buttons be native grey/black
                        attr: { style: "width: 100%; box-sizing: border-box; padding: 15px; cursor: pointer; font-weight: 600; font-size: 1.1em; border-radius: 8px;" }
                    });

                    btn.onclick = () => {
                        applyStateChanges(rawLabel, this.flowState);
                        this.currentNodeId = edge.toNode;
                        this.saveProgress();
                        this.renderStep();
                    };
                });
            }

            if (this.plugin.settings.showDebugState && Object.keys(this.flowState).length > 0) {
                debugContainer.createEl("div", {
                    text: `🐛 Debug State: ${JSON.stringify(this.flowState)}`,
                    attr: { style: "margin-top: 20px; font-family: monospace; font-size: 0.9em; color: var(--text-warning); background: var(--background-modifier-error); padding: 15px; border-radius: 6px; text-align: left; word-break: break-all; white-space: pre-wrap; width: 100%; box-sizing: border-box;" }
                });
            }
        };

        refreshUI();
    }
}


// --- THE PLUGIN CLASS ---
export default class CanvasPlayerPlugin extends Plugin {
    settings: CanvasPlayerSettings;
    playbackSessions: Record<string, { currentNodeId: string, flowState: Record<string, any>, callStack: any[] }> = {};

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new CanvasPlayerSettingTab(this.app, this));

        this.app.workspace.onLayoutReady(() => {
            this.injectCanvasPlayButton();
            this.registerEvent(this.app.workspace.on('layout-change', () => this.injectCanvasPlayButton()));
        });
    }

    private injectCanvasPlayButton() {
        const canvasLeaves = this.app.workspace.getLeavesOfType('canvas');
        canvasLeaves.forEach(leaf => {
            const container = leaf.view.containerEl;

            if (container.querySelector('.canvas-player-play-btn')) return;

            const controlsMenu = container.querySelector('.canvas-controls');
            if (!controlsMenu) return;

            const btnGroup = createEl('div', { cls: 'canvas-control-group canvas-player-play-btn' });
            const playBtn = btnGroup.createEl('button', {
                cls: ['clickable-icon', 'canvas-control-item'],
                attr: { 'aria-label': 'Play Canvas Algorithm' }
            });
            setIcon(playBtn, 'play');

            controlsMenu.append(btnGroup);

            playBtn.onclick = async () => {
                const file = (leaf.view as any).file;
                if (!file) return;

                const fileData = await this.app.vault.read(file);
                const savedSession = this.playbackSessions[file.path];
                new CanvasPlayerModal(this.app, this, file, fileData, savedSession).open();
            };
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}


// --- THE SETTINGS TAB UI ---
class CanvasPlayerSettingTab extends PluginSettingTab {
    plugin: CanvasPlayerPlugin;

    constructor(app: App, plugin: CanvasPlayerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Canvas Player Settings' });

        new Setting(containerEl)
            .setName('Show Logic Debugger & Warnings')
            .setDesc('Displays hidden state variables and typo warnings. Turn off for distraction-free study.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showDebugState)
                .onChange(async (value) => {
                    this.plugin.settings.showDebugState = value;
                    await this.plugin.saveSettings();
                }));

        // --- DOCUMENTATION PAGE ---
        const docs = containerEl.createEl('div', { attr: { style: "margin-top: 3rem; padding: 1.5rem; background: var(--background-secondary); border-radius: 8px; border: 1px solid var(--background-modifier-border);" } });

        docs.createEl('h2', { text: "📖 Logic Engine V2 Documentation", attr: { style: "margin-top: 0; color: var(--text-accent);" } });
        docs.createEl('p', { text: "The Canvas Player engine supports Turing-complete JavaScript execution directly on your edge labels, as well as nested sub-graphs and user inputs." });

        docs.createEl('h3', { text: "1. Nested Sub-Graphs" });
        docs.createEl('p', { text: "To call another canvas file, simply make the node's text exactly an Obsidian internal link:" });
        docs.createEl('pre', { attr: { style: "background: var(--background-primary); padding: 10px; border-radius: 4px;" } }).createEl('code', { text: "[[My Other Protocol]]" });

        docs.createEl('h3', { text: "2. User Text Inputs: #{ ... }" });
        docs.createEl('p', { text: "Type this anywhere in a node to magically turn it into an interactive text box. The typed value will be saved instantly to your logic state." });
        docs.createEl('pre', { attr: { style: "background: var(--background-primary); padding: 10px; border-radius: 4px;" } }).createEl('code', { text: "What is your character's name? #{ player_name }" });

        docs.createEl('h3', { text: "3. Conditions: ?{ ... }" });
        docs.createEl('p', { text: "Wrap logic in ?{ } to conditionally show a path. If it evaluates to false, the button is hidden." });
        docs.createEl('ul').innerHTML = `
            <li><code>?{ hp > 0 }</code> (Standard math check)</li>
            <li><code>?{ root_type === 'complex' }</code> (Checking a string. <b>Strings must be wrapped in quotes!</b>)</li>
            <li><code>?{ count < 5 && is_solved === true }</code> (Compound logic using AND / OR)</li>
        `;

        docs.createEl('h3', { text: "4. Actions & Mutations: !{ ... }" });
        docs.createEl('p', { text: "Wrap assignments in !{ } to mutate state when a button is clicked. You can do math, or change enums." });
        docs.createEl('ul').innerHTML = `
            <li><code>!{ count += 1 }</code> (Increments a variable. Defaults to 0 if missing!)</li>
            <li><code>!{ root_type = 'euler'; count = 0 }</code> (Sets multiple variables using semicolons)</li>
        `;
    }
}