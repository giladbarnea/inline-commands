/**
 * Inline skill aliases.
 *
 * Expands skill references that appear anywhere in interactive input — both the
 * bare `/name` convenience alias and the native `/skill:name` form — into the
 * skill's full `<skill>` block. Everything else (built-in commands, prompt
 * templates) is left untouched for Pi to handle natively.
 *
 * Also adds inline autocomplete for bare skill aliases: typing `/` as a token
 * anywhere in the editor shows skill names directly, without the `skill:` prefix.
 * A period after a bare or native skill name traverses its nested directories and Markdown files.
 *
 * Behavior spec:
 *
 * When Pi starts a session, the extension loads all skills (enabled and disabled alike) from Pi’s package manager and local settings.
 *
 * When the session is TUI, it registers an autocomplete provider.
 *
 * When autocomplete is requested and the cursor is after an inline slash token like `please /sem`, the extension suggests all skill names directly, without `skill:`.
 *
 * When a bare slash token is at the very start of the first line, the extension preserves Pi’s native slash-command suggestions and adds non-prefixed skill aliases.
 *
 * When a slash token starts at editor position 0,0, native commands remain available even if no skill matches.
 *
 * When an inline slash token matches no skill, autocomplete closes rather than suggesting native commands that cannot execute inline.
 *
 * When the user types `/`, the editor triggers autocomplete immediately unless autocomplete was already open.
 *
 * When the autocomplete provider is installed, it preloads native command names for deterministic editor coloring.
 *
 * When the editor renders text, exact skill tokens use the theme accent color and exact native command tokens use the code color.
 *
 * When a slash token is partial or unknown, it remains uncolored.
 *
 * When another extension installs a custom editor before or after this extension, the autocomplete-provider rebuild decorates that editor instead of replacing it.
 *
 * When no editor was installed, it decorates Pi’s `CustomEditor`.
 *
 * When interactive input is submitted, the extension scans for skill tokens like `/semantic-search`.
 *
 * When a token matches any skill name, the extension removes that token from the prose and prepends the full `<skill ...>...</skill>` block.
 *
 * When multiple skill tokens are present, all matching skills are expanded.
 *
 * When a period follows a bare or native skill name, autocomplete shows that skill directory's direct children except `SKILL.md`.
 *
 * When a directory completion is accepted, it appends a period and reopens autocomplete at the next level.
 *
 * When a nested Markdown file token is submitted, the extension expands only that file.
 *
 * When prose remains after skill removal, the extension trims it and appends it as plain text after a blank line, preserving internal line breaks.
 *
 * When a slash token is unknown, native, or not a skill name, the extension leaves the input untouched.
 *
 * When input is not from the interactive editor, the extension does nothing.
 *
 * References:
 * - /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md
 * - /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md
 * - /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/skills.md
 * - /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/README.md
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	CustomEditor,
	DefaultPackageManager,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
	getAgentDir,
	loadSkills,
	SettingsManager,
	stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	type EditorComponent,
	fuzzyFilter,
} from "@earendil-works/pi-tui";

type SkillCatalog = Map<string, Skill>;
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

type SkillInvocation =
	| { kind: "skill"; skillName: string }
	| { filePath: string; kind: "skill-file"; skillName: string };

type SkillBoundary = {
	slashIndex: number;
	commandEndIndex: number;
	invocation: SkillInvocation;
};

type SkillTreeEntry = {
	isDirectory: boolean;
	name: string;
	path: string;
};

type SkillTreeLocation = {
	directoryPath: string;
	pathPrefix: string;
	query: string;
};

type AutocompleteTriggerEditor = {
	getCursor?: () => { col: number; line: number };
	getLines?: () => string[];
	isShowingAutocomplete?: () => boolean;
	tryTriggerAutocomplete?: (explicitTab?: boolean) => void;
};

type MaybeModeContext = ExtensionContext & { mode?: string };

type TextFormatter = (text: string) => string;

type AnsiStyle = {
	close: string;
	open: string;
};

type SkillAutocompleteToken = {
	isNativeSkillForm: boolean;
	prefix: string;
	query: string;
	referenceExpression: string | undefined;
	skillName: string;
	slashIndex: number;
};

const MAX_SKILL_SUGGESTIONS = 20;
const SKILL_SCOPE_TAGS: Record<Skill["sourceInfo"]["scope"], string> = {
	project: "p",
	temporary: "t",
	user: "u",
};
const STYLE_SENTINEL = "__PI_INLINE_COMMAND_STYLE_SENTINEL__";

function isTuiContext(ctx: ExtensionContext): boolean {
	const mode = (ctx as MaybeModeContext).mode;
	return mode === undefined ? ctx.hasUI : mode === "tui";
}

function renderSkillInvocation(skill: Skill): string {
	const content = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
	return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${content}\n</skill>`;
}

function renderSkillFileInvocation(invocation: Extract<SkillInvocation, { kind: "skill-file" }>): string {
	const content = stripFrontmatter(readFileSync(invocation.filePath, "utf8")).trim();
	return `<skill-file skill="${invocation.skillName}" location="${invocation.filePath}">\nReferences are relative to ${dirname(invocation.filePath)}.\n\n${content}\n</skill-file>`;
}

function getSkillTreeEntries(directoryPath: string): SkillTreeEntry[] {
	return readdirSync(directoryPath, { withFileTypes: true })
		.filter((entry) => entry.name !== "SKILL.md")
		.map((entry) => {
			const entryPath = join(directoryPath, entry.name);
			return {
				isDirectory:
					entry.isDirectory() || (entry.isSymbolicLink() && statSync(entryPath).isDirectory()),
				name: entry.name,
				path: entryPath,
			};
		})
		.filter((entry) => entry.isDirectory || entry.name.endsWith(".md"))
		.sort(
			(left, right) =>
				Number(right.isDirectory) - Number(left.isDirectory) || left.name.localeCompare(right.name),
		);
}

function resolveSkillTreeLocation(skill: Skill, referenceExpression: string): SkillTreeLocation {
	let directoryPath = skill.baseDir;
	let pathPrefix = "";
	let query = referenceExpression;

	while (query) {
		const matchingDirectory = getSkillTreeEntries(directoryPath)
			.filter((entry) => entry.isDirectory && query.startsWith(`${entry.name}.`))
			.sort((left, right) => right.name.length - left.name.length)[0];
		if (!matchingDirectory) break;
		directoryPath = matchingDirectory.path;
		pathPrefix += `${matchingDirectory.name}.`;
		query = query.slice(matchingDirectory.name.length + 1);
	}

	return { directoryPath, pathPrefix, query };
}

function resolveSkillMarkdownFile(skill: Skill, referenceExpression: string): string | undefined {
	const location = resolveSkillTreeLocation(skill, referenceExpression);
	return getSkillTreeEntries(location.directoryPath).find(
		(entry) => !entry.isDirectory && entry.name === location.query,
	)?.path;
}

function normalizeSkillResourcePath(resourcePath: string): string {
	try {
		// `resolve()` can describe a skill by its directory, while `loadSkills()` reports SKILL.md.
		if (statSync(resourcePath).isDirectory()) {
			const skillFilePath = join(resourcePath, "SKILL.md");
			if (existsSync(skillFilePath)) {
				return skillFilePath;
			}
		}
	} catch {}

	return resourcePath;
}

function getSkillInvocationFromSlashToken(
	tokenText: string,
	catalog: SkillCatalog,
): SkillInvocation | undefined {
	const isNativeSkillForm = tokenText.startsWith("/skill:");
	const commandText = isNativeSkillForm ? tokenText.slice("/skill:".length) : tokenText.slice(1);
	if (catalog.has(commandText)) return { kind: "skill", skillName: commandText };

	const separatorIndex = commandText.indexOf(".");
	if (separatorIndex === -1) return undefined;
	const skillName = commandText.slice(0, separatorIndex);
	const skill = catalog.get(skillName);
	if (!skill) return undefined;
	const filePath = resolveSkillMarkdownFile(skill, commandText.slice(separatorIndex + 1));
	return filePath ? { filePath, kind: "skill-file", skillName } : undefined;
}

// Finds exact skill references preceded by start-of-string or whitespace.
// Unknown /tokens pass through untouched for Pi to handle.
function findSkillBoundaries(text: string, catalog: SkillCatalog): SkillBoundary[] {
	const boundaries: SkillBoundary[] = [];
	const pattern = /(^|\s)(\/[^\s]+)/g;
	for (const match of text.matchAll(pattern)) {
		const tokenText = match[2]!;
		const invocation = getSkillInvocationFromSlashToken(tokenText, catalog);
		if (!invocation) continue;
		const slashIndex = match.index! + match[1]!.length;
		boundaries.push({
			slashIndex,
			invocation,
			commandEndIndex: slashIndex + tokenText.length,
		});
	}
	return boundaries;
}

// Excises each skill reference from the text and returns its expansion plus the surviving prose.
// Skills are zero-arg: only the `/name` token itself is removed; surrounding text is kept verbatim.
function expandSkillInvocations(
	text: string,
	boundaries: SkillBoundary[],
	catalog: SkillCatalog,
): { expansions: string[]; remainingText: string } {
	const expansions: string[] = [];
	const keptSegments: string[] = [];
	let cursor = 0;

	for (const boundary of boundaries) {
		keptSegments.push(text.slice(cursor, boundary.slashIndex));
		cursor = boundary.commandEndIndex;
		if (boundary.invocation.kind === "skill-file") {
			expansions.push(renderSkillFileInvocation(boundary.invocation));
			continue;
		}
		const skill = catalog.get(boundary.invocation.skillName);
		if (!skill) throw new Error(`Skill disappeared from catalog: ${boundary.invocation.skillName}`);
		expansions.push(renderSkillInvocation(skill));
	}

	keptSegments.push(text.slice(cursor));
	return { expansions, remainingText: keptSegments.join("") };
}

async function loadSkillCatalog(cwd: string): Promise<SkillCatalog> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolvedPaths = await packageManager.resolve();
	const skillResources = resolvedPaths.skills.map((resource) => ({
		...resource,
		path: normalizeSkillResourcePath(resource.path),
	}));
	const resourceByPath = new Map(skillResources.map((resource) => [resource.path, resource]));
	const skills = loadSkills({
		cwd,
		agentDir,
		skillPaths: skillResources.map((resource) => resource.path),
		includeDefaults: false,
	}).skills;

	return new Map(
		skills.map((skill) => {
			const resource = resourceByPath.get(skill.filePath);
			if (!resource) throw new Error(`Pi returned no source metadata for skill: ${skill.filePath}`);
			return [
				skill.name,
				{
					...skill,
					sourceInfo: { path: skill.filePath, ...resource.metadata },
				},
			];
		}),
	);
}

function extractSkillAutocompleteToken(textBeforeCursor: string): SkillAutocompleteToken | undefined {
	const match = /(?<=^|\s)\/(skill:)?([a-zA-Z0-9-]*)(?:\.([^\s]*))?$/.exec(textBeforeCursor);
	if (!match) return undefined;
	const skillName = match[2]!;
	const referenceExpression = match[3];
	return {
		isNativeSkillForm: match[1] !== undefined,
		prefix:
			referenceExpression === undefined
				? skillName
				: `${match[1] ?? ""}${skillName}.${referenceExpression}`,
		query: skillName,
		referenceExpression,
		skillName,
		slashIndex: match.index,
	};
}

function getSkillAutocompleteItems(catalog: SkillCatalog, query: string): AutocompleteItem[] {
	const items = [...catalog.values()].map((skill) => ({
		value: skill.name,
		label: skill.name,
		description: `[${SKILL_SCOPE_TAGS[skill.sourceInfo.scope]}] ${skill.description}`,
	}));

	if (!query) {
		return items.slice(0, MAX_SKILL_SUGGESTIONS);
	}

	return fuzzyFilter(items, query, (item) => item.value).slice(0, MAX_SKILL_SUGGESTIONS);
}

function getSkillFileAutocompleteItems(
	skill: Skill,
	referenceExpression: string,
	isNativeSkillForm: boolean,
): AutocompleteItem[] {
	const location = resolveSkillTreeLocation(skill, referenceExpression);
	const invocationPrefix = isNativeSkillForm ? "skill:" : "";
	const entries = getSkillTreeEntries(location.directoryPath);
	const matches = location.query
		? fuzzyFilter(entries, location.query, (entry) => entry.name)
		: entries;

	return matches.slice(0, MAX_SKILL_SUGGESTIONS).map((entry) => ({
		value: `${invocationPrefix}${skill.name}.${location.pathPrefix}${entry.name}${entry.isDirectory ? "." : ""}`,
		label: entry.name,
		description: entry.isDirectory ? "directory" : "Markdown file",
	}));
}

function isSkillFileAutocompletePrefix(prefix: string, catalog: SkillCatalog): boolean {
	const commandText = prefix.startsWith("skill:") ? prefix.slice("skill:".length) : prefix;
	const separatorIndex = commandText.indexOf(".");
	return separatorIndex !== -1 && catalog.has(commandText.slice(0, separatorIndex));
}

function applySkillFileCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: AutocompleteItem,
	prefix: string,
): { cursorCol: number; cursorLine: number; lines: string[] } {
	const currentLine = lines[cursorLine] ?? "";
	const slashIndex = cursorCol - prefix.length - 1;
	if (currentLine[slashIndex] !== "/") {
		throw new Error(`Nested skill completion lost its slash prefix: ${prefix}`);
	}

	const nextLines = [...lines];
	nextLines[cursorLine] = `${currentLine.slice(0, slashIndex)}/${item.value}${currentLine.slice(cursorCol)}`;
	return {
		lines: nextLines,
		cursorLine,
		cursorCol: slashIndex + item.value.length + 1,
	};
}

function rememberNativeCommandNames(
	nativeCommandNames: Set<string>,
	items: readonly AutocompleteItem[],
): void {
	for (const item of items) nativeCommandNames.add(item.value);
}

function preloadNativeCommandNames(
	current: AutocompleteProvider,
	nativeCommandNames: Set<string>,
): void {
	void current
		.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal })
		.then((suggestions) => {
			if (suggestions) rememberNativeCommandNames(nativeCommandNames, suggestions.items);
		});
}

function createSkillAutocompleteProvider(
	current: AutocompleteProvider,
	getCatalog: () => Promise<SkillCatalog>,
	getLoadedCatalog: () => SkillCatalog,
	nativeCommandNames: Set<string>,
	requestAutocomplete: () => void,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const token = extractSkillAutocompleteToken(textBeforeCursor);
			if (token === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const catalog = await getCatalog();
			if (token.referenceExpression !== undefined) {
				const skill = catalog.get(token.skillName);
				if (!skill) return current.getSuggestions(lines, cursorLine, cursorCol, options);
				const items = options.signal.aborted
					? []
					: getSkillFileAutocompleteItems(
							skill,
							token.referenceExpression,
							token.isNativeSkillForm,
						);
				return items.length === 0 ? null : { prefix: token.prefix, items };
			}

			const atMessageStart = cursorLine === 0 && token.slashIndex === 0;
			const nativeSuggestions = atMessageStart
				? await current.getSuggestions(lines, cursorLine, cursorCol, options)
				: undefined;
			if (nativeSuggestions) rememberNativeCommandNames(nativeCommandNames, nativeSuggestions.items);
			if (atMessageStart && token.isNativeSkillForm) {
				return nativeSuggestions ?? null;
			}

			const skillItems = options.signal.aborted ? [] : getSkillAutocompleteItems(catalog, token.query);
			if (skillItems.length === 0) {
				return nativeSuggestions ?? null;
			}

			if (!atMessageStart) {
				return { prefix: token.prefix, items: skillItems };
			}

			const nativeItems = nativeSuggestions?.items ?? [];
			const nativeValues = new Set(nativeItems.map((item) => item.value));
			const nativeSkillDescriptions = new Map(
				nativeItems
					.filter((item) => item.value.startsWith("skill:"))
					.map((item) => [item.value.slice("skill:".length), item.description]),
			);
			const bareSkillItems = skillItems
				.filter((item) => !nativeValues.has(item.value))
				.map((item) => ({
					...item,
					description: nativeSkillDescriptions.get(item.value) ?? item.description,
				}));
			return {
				prefix: nativeSuggestions?.prefix ?? textBeforeCursor,
				items: [...nativeItems, ...bareSkillItems],
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!isSkillFileAutocompletePrefix(prefix, getLoadedCatalog())) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			const completion = applySkillFileCompletion(lines, cursorLine, cursorCol, item, prefix);
			if (item.value.endsWith(".")) requestAutocomplete();
			return completion;
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function getPrintableCharacter(data: string): string | undefined {
	return decodeKittyPrintable(data) ?? (data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined);
}

function getAutocompleteTrigger(editor: EditorComponent): AutocompleteTriggerEditor {
	return editor as unknown as AutocompleteTriggerEditor;
}

function triggerAutocomplete(editor: EditorComponent): void {
	const trigger = getAutocompleteTrigger(editor).tryTriggerAutocomplete;
	if (typeof trigger === "function") {
		trigger.call(editor, false);
	}
}

function isShowingAutocomplete(editor: EditorComponent): boolean {
	const reader = getAutocompleteTrigger(editor).isShowingAutocomplete;
	return typeof reader === "function" ? reader.call(editor) : false;
}

function getTextBeforeEditorCursor(editor: EditorComponent): string {
	const autocompleteEditor = getAutocompleteTrigger(editor);
	const cursor = autocompleteEditor.getCursor?.call(editor);
	const lines = autocompleteEditor.getLines?.call(editor);
	if (cursor && lines) return (lines[cursor.line] ?? "").slice(0, cursor.col);
	return editor.getText().split("\n").at(-1) ?? "";
}

function isSkillPeriodContext(editor: EditorComponent, catalog: SkillCatalog): boolean {
	const token = extractSkillAutocompleteToken(getTextBeforeEditorCursor(editor));
	return token !== undefined && catalog.has(token.skillName);
}

function createAnsiStyle(formatter: TextFormatter): AnsiStyle | undefined {
	const formatted = formatter(STYLE_SENTINEL);
	const sentinelIndex = formatted.indexOf(STYLE_SENTINEL);
	if (sentinelIndex === -1) return undefined;
	return {
		open: formatted.slice(0, sentinelIndex),
		close: formatted.slice(sentinelIndex + STYLE_SENTINEL.length),
	};
}

function getEscapeSequenceEnd(text: string, startIndex: number): number {
	const introducer = text[startIndex + 1];
	if (introducer === "[") {
		for (let index = startIndex + 2; index < text.length; index += 1) {
			const code = text.charCodeAt(index);
			if (code >= 0x40 && code <= 0x7e) return index + 1;
		}
		return text.length;
	}

	if (introducer === "]" || introducer === "_") {
		const bellIndex = text.indexOf("\x07", startIndex + 2);
		const stringTerminatorIndex = text.indexOf("\x1b\\", startIndex + 2);
		const endCandidates = [bellIndex, stringTerminatorIndex].filter((index) => index !== -1);
		if (endCandidates.length === 0) return text.length;
		const endIndex = Math.min(...endCandidates);
		return endIndex + (endIndex === stringTerminatorIndex ? 2 : 1);
	}

	return Math.min(text.length, startIndex + 2);
}

function isSgrSequence(sequence: string): boolean {
	return /^\x1b\[[0-9;?]*m$/.test(sequence);
}

function getVisibleText(text: string): string {
	let visibleText = "";
	for (let index = 0; index < text.length; ) {
		if (text[index] === "\x1b") {
			index = getEscapeSequenceEnd(text, index);
			continue;
		}
		visibleText += text[index];
		index += 1;
	}
	return visibleText;
}

function getSlashTokenRanges(
	visibleText: string,
	catalog: SkillCatalog,
	nativeCommandNames: ReadonlySet<string>,
	skillStyle: AnsiStyle,
	nonSkillStyle: AnsiStyle,
): Array<{ end: number; start: number; style: AnsiStyle }> {
	return [...visibleText.matchAll(/(^|\s)(\/[^\s]+)/g)].flatMap((match) => {
		const leadingText = match[1] ?? "";
		const tokenText = match[2] ?? "";
		const skillInvocation = getSkillInvocationFromSlashToken(tokenText, catalog);
		const nativeCommandName = tokenText.slice(1);
		let style = skillInvocation ? skillStyle : undefined;
		if (!style && nativeCommandNames.has(nativeCommandName)) style = nonSkillStyle;
		if (!style) return [];

		const start = match.index! + leadingText.length;
		return [{ start, end: start + tokenText.length, style }];
	});
}

function colorSlashTokens(
	text: string,
	skillFormatter: TextFormatter,
	nonSkillFormatter: TextFormatter,
	catalog: SkillCatalog,
	nativeCommandNames: ReadonlySet<string>,
): string {
	const skillStyle = createAnsiStyle(skillFormatter);
	const nonSkillStyle = createAnsiStyle(nonSkillFormatter);
	if (!skillStyle || !nonSkillStyle) return text;

	const ranges = getSlashTokenRanges(
		getVisibleText(text),
		catalog,
		nativeCommandNames,
		skillStyle,
		nonSkillStyle,
	);
	if (ranges.length === 0) return text;

	let result = "";
	let rangeIndex = 0;
	let visibleIndex = 0;
	let activeStyle: AnsiStyle | undefined;

	for (let index = 0; index < text.length; ) {
		if (activeStyle && ranges[rangeIndex]?.end === visibleIndex) {
			result += activeStyle.close;
			activeStyle = undefined;
			rangeIndex += 1;
		}

		if (!activeStyle && ranges[rangeIndex]?.start === visibleIndex) {
			activeStyle = ranges[rangeIndex]!.style;
			result += activeStyle.open;
		}

		if (text[index] === "\x1b") {
			const endIndex = getEscapeSequenceEnd(text, index);
			const sequence = text.slice(index, endIndex);
			result += sequence;
			if (activeStyle && isSgrSequence(sequence)) result += activeStyle.open;
			index = endIndex;
			continue;
		}

		result += text[index];
		visibleIndex += 1;
		index += 1;
	}

	return activeStyle ? result + activeStyle.close : result;
}

function decorateSlashAutocompleteEditor<T extends EditorComponent>(
	editor: T,
	getSkillCatalog: () => SkillCatalog,
	nativeCommandNames: ReadonlySet<string>,
	skillSlashTokenColor: TextFormatter,
	nonSkillSlashTokenColor: TextFormatter,
): T {
	const render = editor.render.bind(editor);
	editor.render = (width) =>
		render(width).map((line) =>
			colorSlashTokens(
				line,
				skillSlashTokenColor,
				nonSkillSlashTokenColor,
				getSkillCatalog(),
				nativeCommandNames,
			),
		);

	const handleInput = editor.handleInput.bind(editor);
	editor.handleInput = (data) => {
		const printableCharacter = getPrintableCharacter(data);
		const wasShowingAutocomplete = isShowingAutocomplete(editor);
		handleInput(data);
		const shouldTrigger =
			printableCharacter === "/" ||
			(printableCharacter === "." && isSkillPeriodContext(editor, getSkillCatalog()));
		if (shouldTrigger && !wasShowingAutocomplete) triggerAutocomplete(editor);
	};

	return editor;
}

export default function inlineCommands(pi: ExtensionAPI): void {
	const nativeCommandNames = new Set<string>();
	let skillCatalog: SkillCatalog = new Map();
	let skillCatalogPromise: Promise<void> | undefined;
	let slashAutocompleteEditor: EditorComponent | undefined;
	let slashAutocompleteEditorFactory: EditorFactory | undefined;

	function refreshSkillCatalog(cwd: string): Promise<void> {
		skillCatalogPromise = loadSkillCatalog(cwd)
			.then((catalog) => {
				skillCatalog = catalog;
			})
			.finally(() => {
				skillCatalogPromise = undefined;
			});

		return skillCatalogPromise;
	}

	async function getSkillCatalog(cwd: string): Promise<SkillCatalog> {
		if (!skillCatalogPromise && skillCatalog.size === 0) {
			await refreshSkillCatalog(cwd);
		}
		await skillCatalogPromise;
		return skillCatalog;
	}

	function installSlashAutocompleteEditor(ctx: ExtensionContext): void {
		if (!isTuiContext(ctx)) return;

		const previousEditorFactory = ctx.ui.getEditorComponent();
		if (slashAutocompleteEditorFactory && previousEditorFactory === slashAutocompleteEditorFactory) return;

		slashAutocompleteEditorFactory = (tui, theme, keybindings) => {
			const editor = previousEditorFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			slashAutocompleteEditor = decorateSlashAutocompleteEditor(
				editor,
				() => skillCatalog,
				nativeCommandNames,
				(text) => ctx.ui.theme.fg("accent", text),
				(text) => ctx.ui.theme.fg("mdCode", text),
			);
			return slashAutocompleteEditor;
		};
		ctx.ui.setEditorComponent(slashAutocompleteEditorFactory);
	}

	pi.on("session_start", (_event, ctx) => {
		const refresh = refreshSkillCatalog(ctx.cwd);
		if (isTuiContext(ctx)) {
			ctx.ui.addAutocompleteProvider((current) => {
				// Pi rebuilds this chain after all session_start handlers, including later editor replacements.
				installSlashAutocompleteEditor(ctx);
				preloadNativeCommandNames(current, nativeCommandNames);
				return createSkillAutocompleteProvider(
					current,
					() => getSkillCatalog(ctx.cwd),
					() => skillCatalog,
					nativeCommandNames,
					() => {
						queueMicrotask(() => {
							if (slashAutocompleteEditor) triggerAutocomplete(slashAutocompleteEditor);
						});
					},
				);
			});
			installSlashAutocompleteEditor(ctx);
		}
		return refresh;
	});

	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive") {
			return { action: "continue" };
		}

		const catalog = await getSkillCatalog(ctx.cwd);
		const boundaries = findSkillBoundaries(event.text, catalog);
		if (boundaries.length === 0) {
			return { action: "continue" };
		}

		const { expansions, remainingText } = expandSkillInvocations(
			event.text,
			boundaries,
			catalog,
		);

		return {
			action: "transform",
			text: [...expansions, remainingText.trim()].filter(Boolean).join("\n\n"),
		};
	});
}
