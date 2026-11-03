#!/usr/bin/env node

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DefaultPackageManager,
	SettingsManager,
	getAgentDir,
	loadSkills,
	stripFrontmatter,
	createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent")));

const extensionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = resolve(extensionDirectory, "index.ts");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-inline-commands-"));
process.env.PI_CODING_AGENT_DIR = join(temporaryDirectory, "agent");
const agentDir = getAgentDir();
const cwd = join(temporaryDirectory, "workspace");
mkdirSync(cwd, { recursive: true });
for (const skillName of ["disabled-fixture", "ai-to-leader", "ai-to-delegated"]) {
	const skillDirectory = join(agentDir, "skills", skillName);
	mkdirSync(skillDirectory, { recursive: true });
	writeFileSync(join(skillDirectory, "SKILL.md"), `---\nname: ${skillName}\ndescription: Regression fixture\n---\nSkill instructions.\n`);
}
const referencesDirectory = join(agentDir, "skills", "ai-to-leader", "references");
mkdirSync(referencesDirectory);
for (const name of ["help.md", "human.md", "show-me.md", "token-economic-communication.md"]) {
	writeFileSync(join(referencesDirectory, name), `# ${name}\nReference instructions.\n`);
}
const deepDirectory = join(agentDir, "skills", "ai-to-delegated", "configurations", "hillclimber-watcher");
mkdirSync(deepDirectory, { recursive: true });
for (const name of ["protocol.md", "watcher.md"]) writeFileSync(join(deepDirectory, name), "Deep instructions.\n");
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: ["-skills/disabled-fixture/SKILL.md"] }));

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function findDisabledSkill() {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolvedPaths = await packageManager.resolve();
	const allSkillPaths = resolvedPaths.skills.map((resource) => resource.path);
	const enabledSkillPaths = resolvedPaths.skills
		.filter((resource) => resource.enabled)
		.map((resource) => resource.path);
	const allSkills = loadSkills({ cwd, agentDir, skillPaths: allSkillPaths, includeDefaults: false }).skills;
	const enabledSkillNames = new Set(
		loadSkills({ cwd, agentDir, skillPaths: enabledSkillPaths, includeDefaults: false }).skills.map(
			(skill) => skill.name,
		),
	);
	const disabledSkill = allSkills.find((skill) => !enabledSkillNames.has(skill.name));
	assert(disabledSkill, "Expected at least one disabled skill to test all-skill support");
	return disabledSkill;
}

function createCurrentAutocompleteProvider(skillName) {
	let delegated = false;
	const nativeSkillDescription = "[u] Native skill description";
	return {
		get delegated() {
			return delegated;
		},
		resetDelegated() {
			delegated = false;
		},
		async getSuggestions(lines, cursorLine, cursorCol) {
			delegated = true;
			const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol);
			return {
				prefix,
				items: [
					{ value: "native", label: "native" },
					{ value: "settings", label: "settings" },
					{
						value: `skill:${skillName}`,
						label: `skill:${skillName}`,
						description: nativeSkillDescription,
					},
				],
			};
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine] ?? "";
			const before = line.slice(0, cursorCol - prefix.length);
			const after = line.slice(cursorCol);
			const completion = prefix.startsWith("/") ? `/${item.value} ` : item.value;
			const nextLines = [...lines];
			nextLines[cursorLine] = `${before}${completion}${after}`;
			return {
				lines: nextLines,
				cursorLine,
				cursorCol: before.length + completion.length,
			};
		},
		shouldTriggerFileCompletion() {
			return true;
		},
	};
}

async function testSkillMessageFormats(input, ctx, skill) {
	const skillContent = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
	const expectedSkill = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${skillContent}\n</skill>`;
	for (const token of [`/${skill.name}`, `/skill:${skill.name}`]) {
		for (const [text, expected] of [
			[token, expectedSkill],
			[`\n  ${token} \t\n`, expectedSkill],
			[`${token}  explain this skill  `, `${expectedSkill}\n\nexplain this skill`],
			[
				`${token}\n\n  explain this skill\nand keep this line  `,
				`${expectedSkill}\n\nexplain this skill\nand keep this line`,
			],
			[`please ${token} now`, `${expectedSkill}\n\nplease  now`],
			[`first line\n${token}\nsecond line`, `${expectedSkill}\n\nfirst line\n\nsecond line`],
		]) {
			const transformed = await input({ type: "input", source: "interactive", text }, ctx);
			assert(
				transformed.action === "transform" && transformed.text === expected,
				`Skill expansion changed the native block or plain request for ${JSON.stringify(text)}: ${JSON.stringify(transformed)}`,
			);
		}
	}

	const multipleText = `start /${skill.name}\n/skill:${skill.name} finish /doesnotexist`;
	const multiple = await input({ type: "input", source: "interactive", text: multipleText }, ctx);
	assert(
		multiple.action === "transform" &&
			multiple.text === `${expectedSkill}\n\n${expectedSkill}\n\nstart \n finish /doesnotexist`,
		`Multiple skill expansion changed the plain request or unknown token: ${JSON.stringify(multiple)}`,
	);

	const helpPath = resolve(agentDir, "skills", "ai-to-leader", "references", "help.md");
	const helpContent = stripFrontmatter(readFileSync(helpPath, "utf8")).trim();
	const expectedHelp = `<skill-file skill="ai-to-leader" location="${helpPath}">\nReferences are relative to ${dirname(helpPath)}.\n\n${helpContent}\n</skill-file>`;
	for (const token of ["/ai-to-leader.references.help.md", "/skill:ai-to-leader.references.help.md"]) {
		for (const [text, expected] of [
			[token, expectedHelp],
			[`${token}\n\n  ok great, what expanded?  `, `${expectedHelp}\n\nok great, what expanded?`],
			[`before\n${token}\nafter`, `${expectedHelp}\n\nbefore\n\nafter`],
		]) {
			const transformed = await input({ type: "input", source: "interactive", text }, ctx);
			assert(
				transformed.action === "transform" && transformed.text === expected,
				`Nested Markdown expansion changed the skill-file block or plain request: ${JSON.stringify(transformed)}`,
			);
		}
	}

	for (const text of [
		`please /${skill.name}XX now`,
		`please /skill:${skill.name}XX now`,
		"please /doesnotexist now",
		"please /ai-to-leader.SKILL.md now",
		"/settings",
	]) {
		const transformed = await input({ type: "input", source: "interactive", text }, ctx);
		assert(
			transformed.action === "continue",
			`Unexpected expansion for non-exact or native token ${text}: ${JSON.stringify(transformed)}`,
		);
	}

	for (const source of ["rpc", "extension"]) {
		const transformed = await input({ type: "input", source, text: `/${skill.name} explain this` }, ctx);
		assert(
			transformed.action === "continue",
			`Unexpected expansion for ${source} input: ${JSON.stringify(transformed)}`,
		);
	}
}

async function main() {
	const disabledSkill = await findDisabledSkill();
	const skillName = disabledSkill.name;
	const result = await loadExtensions([extensionPath], cwd, undefined, createExtensionRuntime());
	assert(result.errors.length === 0, `Extension load failed: ${JSON.stringify(result.errors)}`);

	const extension = result.extensions[0];
	const sessionStart = extension.handlers.get("session_start")?.[0];
	const input = extension.handlers.get("input")?.[0];
	assert(sessionStart, "Missing session_start handler");
	assert(input, "Missing input handler");

	let autocompleteFactory;
	let autocompleteTriggerCount = 0;
	let editorFactory;
	const baseEditor = {
		onSubmit: undefined,
		onChange: undefined,
		getText() {
			return `please /${skillName}`;
		},
		getExpandedText() {
			return `please /${skillName}`;
		},
		setText() {},
		addToHistory() {},
		insertTextAtCursor() {},
		setAutocompleteProvider() {},
		setPaddingX() {},
		setAutocompleteMaxVisible() {},
		handleInput() {},
		invalidate() {},
		isShowingAutocomplete() {
			return false;
		},
		tryTriggerAutocomplete() {
			autocompleteTriggerCount += 1;
		},
		render() {
			return [
				`please /${skillName} now`,
				`please /skill:${skillName} now`,
				`please /${skillName}XX now`,
				`please /skill:${skillName}XX now`,
				"please /doesnotexist now",
				"/settings",
				"/set",
			];
		},
	};
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		ui: {
			theme: { fg: (token, text) => `<${token}>${text}</${token}>` },
			addAutocompleteProvider(factory) {
				autocompleteFactory = factory;
			},
			getEditorComponent() {
				return editorFactory;
			},
			setEditorComponent(factory) {
				editorFactory = factory;
			},
		},
	};

	await sessionStart({ type: "session_start", reason: "startup" }, ctx);
	await testSkillMessageFormats(input, ctx, disabledSkill);
	if (process.argv.includes("--format-only")) {
		console.log(`inline-commands format regression ok, tested disabled skill: ${skillName}`);
		return;
	}
	assert(typeof autocompleteFactory === "function", "Autocomplete provider was not registered");
	assert(typeof editorFactory === "function", "Editor wrapper was not installed");

	const lateEditorFactory = () => baseEditor;
	editorFactory = lateEditorFactory;
	const currentProvider = createCurrentAutocompleteProvider(skillName);
	const provider = autocompleteFactory(currentProvider);
	assert(editorFactory !== lateEditorFactory, "Late custom editor replacement was not decorated");
	await new Promise((resolvePromise) => setImmediate(resolvePromise));
	assert(currentProvider.delegated, "Native command names were not preloaded");
	const editor = editorFactory({}, {}, {});
	assert(editor === baseEditor, "Editor decoration replaced the underlying editor instance");
	assert(
		editor.render(80)[5] === "<mdCode>/settings</mdCode>",
		"Preloaded native command was not colored before interactive autocomplete",
	);

	currentProvider.resetDelegated();
	const startLine = "/";
	const startSuggestions = await provider.getSuggestions([startLine], 0, startLine.length, {
		signal: new AbortController().signal,
	});
	assert(currentProvider.delegated, "Slash at message start did not delegate to native provider");
	assert(startSuggestions?.items[0]?.value === "native", "Native provider result was not preserved");
	assert(
		startSuggestions?.items.some((item) => item.value === `skill:${skillName}`),
		"Native prefixed skill result was not preserved",
	);
	const rootBareSkill = startSuggestions?.items.find((item) => item.value === skillName);
	assert(rootBareSkill, "Bare skill was not added to root slash autocomplete");
	assert(
		rootBareSkill.description === "[u] Native skill description",
		`Bare skill did not preserve the native scope description: ${rootBareSkill.description}`,
	);
	const rootCompletion = provider.applyCompletion(
		[startLine],
		0,
		startLine.length,
		rootBareSkill,
		startSuggestions.prefix,
	);
	assert(
		rootCompletion.lines[0] === `/${skillName} `,
		`Root bare skill completion was applied incorrectly: ${rootCompletion.lines[0]}`,
	);

	currentProvider.resetDelegated();
	const nativeSkillLine = `/skill:${skillName}`;
	const nativeSkillSuggestions = await provider.getSuggestions(
		[nativeSkillLine],
		0,
		nativeSkillLine.length,
		{ signal: new AbortController().signal },
	);
	assert(currentProvider.delegated, "Native skill form did not delegate to native provider");
	assert(
		!nativeSkillSuggestions?.items.some((item) => item.value === skillName),
		"Native skill form unexpectedly added a bare skill completion",
	);

	currentProvider.resetDelegated();
	const bareLine = `please /${skillName}`;
	const bareSuggestions = await provider.getSuggestions([bareLine], 0, bareLine.length, {
		signal: new AbortController().signal,
	});
	assert(!currentProvider.delegated, "Inline bare skill delegated instead of using skill provider");
	const inlineBareSkill = bareSuggestions?.items.find((item) => item.value === skillName);
	assert(inlineBareSkill, "Disabled bare skill did not autocomplete");
	assert(
		/^\[[upt]\] /.test(inlineBareSkill.description),
		`Inline bare skill description omitted its scope: ${inlineBareSkill.description}`,
	);

	const leaderSkillName = "ai-to-leader";
	const leaderRootLine = `/${leaderSkillName}.`;
	currentProvider.resetDelegated();
	const leaderRootSuggestions = await provider.getSuggestions(
		[leaderRootLine],
		0,
		leaderRootLine.length,
		{ signal: new AbortController().signal },
	);
	assert(!currentProvider.delegated, "Nested skill root delegated to the native provider");
	assert(
		leaderRootSuggestions?.items.map((item) => item.label).join(",") === "references",
		`Nested skill root did not show only direct children: ${JSON.stringify(leaderRootSuggestions)}`,
	);
	const referencesItem = leaderRootSuggestions.items[0];
	const triggerCountBeforeCompletion = autocompleteTriggerCount;
	const referencesCompletion = provider.applyCompletion(
		[leaderRootLine],
		0,
		leaderRootLine.length,
		referencesItem,
		leaderRootSuggestions.prefix,
	);
	assert(
		referencesCompletion.lines[0] === `/${leaderSkillName}.references.`,
		`Skill directory completion was applied incorrectly: ${referencesCompletion.lines[0]}`,
	);
	await new Promise((resolvePromise) => setImmediate(resolvePromise));
	assert(
		autocompleteTriggerCount === triggerCountBeforeCompletion + 1,
		"Accepting a skill directory did not reopen autocomplete",
	);

	const referencesLine = referencesCompletion.lines[0];
	const referenceSuggestions = await provider.getSuggestions(
		[referencesLine],
		0,
		referencesLine.length,
		{ signal: new AbortController().signal },
	);
	assert(
		referenceSuggestions?.items.map((item) => item.label).join(",") ===
			"help.md,human.md,show-me.md,token-economic-communication.md",
		`Nested skill directory did not show its direct Markdown files: ${JSON.stringify(referenceSuggestions)}`,
	);
	const helpItem = referenceSuggestions.items.find((item) => item.label === "help.md");
	assert(helpItem, "Nested skill file autocomplete omitted help.md");
	const helpCompletion = provider.applyCompletion(
		[referencesLine],
		0,
		referencesLine.length,
		helpItem,
		referenceSuggestions.prefix,
	);
	assert(
		helpCompletion.lines[0] === `/${leaderSkillName}.references.help.md`,
		`Skill file completion was applied incorrectly: ${helpCompletion.lines[0]}`,
	);

	const deepLine = "/ai-to-delegated.configurations.hillclimber-watcher.";
	const deepSuggestions = await provider.getSuggestions([deepLine], 0, deepLine.length, {
		signal: new AbortController().signal,
	});
	assert(
		deepSuggestions?.items.map((item) => item.label).join(",") === "protocol.md,watcher.md",
		`Arbitrarily deep skill completion failed: ${JSON.stringify(deepSuggestions)}`,
	);

	const typedPeriodTriggerCount = autocompleteTriggerCount;
	editor.handleInput(".");
	assert(
		autocompleteTriggerCount === typedPeriodTriggerCount + 1,
		"Typing a period outside an open menu did not trigger nested skill autocomplete",
	);

	const helpPath = resolve(agentDir, "skills", leaderSkillName, "references", "help.md");
	const expectedHelpContent = stripFrontmatter(readFileSync(helpPath, "utf8")).trim();
	const helpInvocation = await input(
		{ type: "input", source: "interactive", text: helpCompletion.lines[0] },
		ctx,
	);
	const expectedHelpInvocation = `<skill-file skill="${leaderSkillName}" location="${helpPath}">\nReferences are relative to ${dirname(helpPath)}.\n\n${expectedHelpContent}\n</skill-file>`;
	assert(
		helpInvocation.action === "transform" && helpInvocation.text === expectedHelpInvocation,
		`Skill file invocation did not expand only help.md: ${JSON.stringify(helpInvocation)}`,
	);
	const helpInvocationWithMessage = await input(
		{
			type: "input",
			source: "interactive",
			text: `${helpCompletion.lines[0]}\n\n  ok great, what expanded?  `,
		},
		ctx,
	);
	const expectedPlainMessage = `${expectedHelpInvocation}\n\nok great, what expanded?`;
	assert(
		helpInvocationWithMessage.action === "transform" &&
			helpInvocationWithMessage.text === expectedPlainMessage,
		`Remaining user prose was not plain text: ${JSON.stringify(helpInvocationWithMessage)}`,
	);

	const nativeLeaderRootLine = `/skill:${leaderSkillName}.`;
	currentProvider.resetDelegated();
	const nativeLeaderRootSuggestions = await provider.getSuggestions(
		[nativeLeaderRootLine],
		0,
		nativeLeaderRootLine.length,
		{ signal: new AbortController().signal },
	);
	assert(!currentProvider.delegated, "Native nested skill root delegated to the native provider");
	const nativeReferencesItem = nativeLeaderRootSuggestions?.items.find(
		(item) => item.label === "references",
	);
	assert(nativeReferencesItem, "Native nested skill root omitted references");
	const nativeTriggerCountBeforeCompletion = autocompleteTriggerCount;
	const nativeReferencesCompletion = provider.applyCompletion(
		[nativeLeaderRootLine],
		0,
		nativeLeaderRootLine.length,
		nativeReferencesItem,
		nativeLeaderRootSuggestions.prefix,
	);
	assert(
		nativeReferencesCompletion.lines[0] === `/skill:${leaderSkillName}.references.`,
		`Native skill directory completion was applied incorrectly: ${nativeReferencesCompletion.lines[0]}`,
	);
	await new Promise((resolvePromise) => setImmediate(resolvePromise));
	assert(
		autocompleteTriggerCount === nativeTriggerCountBeforeCompletion + 1,
		"Accepting a native skill directory did not reopen autocomplete",
	);

	const nativeReferencesLine = nativeReferencesCompletion.lines[0];
	const nativeReferenceSuggestions = await provider.getSuggestions(
		[nativeReferencesLine],
		0,
		nativeReferencesLine.length,
		{ signal: new AbortController().signal },
	);
	const nativeHelpItem = nativeReferenceSuggestions?.items.find((item) => item.label === "help.md");
	assert(nativeHelpItem, "Native nested skill directory omitted help.md");
	const nativeHelpCompletion = provider.applyCompletion(
		[nativeReferencesLine],
		0,
		nativeReferencesLine.length,
		nativeHelpItem,
		nativeReferenceSuggestions.prefix,
	);
	assert(
		nativeHelpCompletion.lines[0] === `/skill:${leaderSkillName}.references.help.md`,
		`Native skill file completion was applied incorrectly: ${nativeHelpCompletion.lines[0]}`,
	);
	const nativeHelpInvocation = await input(
		{ type: "input", source: "interactive", text: nativeHelpCompletion.lines[0] },
		ctx,
	);
	assert(
		nativeHelpInvocation.action === "transform" &&
			nativeHelpInvocation.text === expectedHelpInvocation,
		`Native skill file invocation did not expand help.md: ${JSON.stringify(nativeHelpInvocation)}`,
	);

	currentProvider.resetDelegated();
	const inlineNativeLine = "please /settings";
	const inlineNativeSuggestions = await provider.getSuggestions(
		[inlineNativeLine],
		0,
		inlineNativeLine.length,
		{ signal: new AbortController().signal },
	);
	assert(!currentProvider.delegated, "Inline non-skill token delegated to the native command provider");
	assert(inlineNativeSuggestions === null, "Inline /settings unexpectedly produced autocomplete suggestions");

	const nativeProvider = autocompleteFactory(
		new CombinedAutocompleteProvider([{ name: "settings" }, { name: `skill:${skillName}` }], cwd),
	);
	const query = `/${skillName.slice(0, 5)}`;
	for (const [linesBefore, linePrefix, lineSuffix] of [
		[[], "Foo bar ", " tail"],
		[[], "/ai-to-leader Foo bar ", " tail"],
		[["/ai-to-leader first"], "", " tail"],
		[["/ai-to-leader first"], "Foo bar ", " tail"],
	]) {
		const lines = [...linesBefore, `${linePrefix}${query}${lineSuffix}`];
		const cursorLine = linesBefore.length;
		const cursorCol = linePrefix.length + query.length;
		const suggestions = await nativeProvider.getSuggestions(lines, cursorLine, cursorCol, {
			signal: new AbortController().signal,
		});
		const item = suggestions?.items.find((candidate) => candidate.value === skillName);
		assert(item, `Inline skill was not suggested for ${JSON.stringify(lines)}`);
		const completion = nativeProvider.applyCompletion(lines, cursorLine, cursorCol, item, suggestions.prefix);
		const expectedLines = [...linesBefore, `${linePrefix}/${skillName}${lineSuffix}`];
		assert(
			JSON.stringify(completion.lines) === JSON.stringify(expectedLines) &&
				completion.cursorCol === linePrefix.length + skillName.length + 1,
			`Inline skill completion lost surrounding text: ${JSON.stringify(lines)} -> ${JSON.stringify(completion)}`,
		);
	}

	const skillLine = `please /skill:${skillName}`;
	const skillSuggestions = await provider.getSuggestions([skillLine], 0, skillLine.length, {
		signal: new AbortController().signal,
	});
	assert(
		skillSuggestions?.items.some((item) => item.value === skillName),
		"Disabled skill: form did not autocomplete",
	);

	const rendered = editor.render(80);
	assert(rendered[0] === `please <accent>/${skillName}</accent> now`, `Bad bare color: ${rendered[0]}`);
	assert(
		rendered[1] === `please <accent>/skill:${skillName}</accent> now`,
		`Bad skill: color: ${rendered[1]}`,
	);
	assert(rendered[2] === `please /${skillName}XX now`, `Partial bare token was colored: ${rendered[2]}`);
	assert(
		rendered[3] === `please /skill:${skillName}XX now`,
		`Partial skill: token was colored: ${rendered[3]}`,
	);
	assert(rendered[4] === "please /doesnotexist now", `Unknown token was colored: ${rendered[4]}`);
	assert(rendered[5] === "<mdCode>/settings</mdCode>", `Exact native command had the wrong color: ${rendered[5]}`);
	assert(rendered[6] === "/set", `Partial native command was colored: ${rendered[6]}`);

	console.log(`inline-commands regression ok, tested disabled skill: ${skillName}`);
}

try {
	await main();
} finally {
	rmSync(temporaryDirectory, { recursive: true });
}
