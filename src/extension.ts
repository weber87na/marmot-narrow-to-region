import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
    let activeOriginalUri: vscode.Uri | undefined;
    let activeRange: vscode.Range | undefined;
    let tempFilePath: string | undefined;
    let baseIndent: string = "";
    let originalLanguageId: string = ""; // 紀錄原始語言模式
    let isSyncing = false;
    let syncTimer: NodeJS.Timeout | undefined;

    // --- 工具函數：縮排處理 ---
    function getCommonIndent(text: string): string {
        const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
        if (lines.length === 0) return '';
        const indents = lines.map(line => line.match(/^\s*/)![0]);
        return indents.reduce((common, current) => {
            let i = 0;
            while (i < common.length && i < current.length && common[i] === current[i]) i++;
            return common.substring(0, i);
        });
    }

    function removeIndent(text: string, indent: string): string {
        if (!indent) return text;
        return text.split(/\r?\n/).map(line => line.startsWith(indent) ? line.substring(indent.length) : line).join('\n');
    }

    function addIndent(text: string, indent: string): string {
        if (!indent) return text;
        return text.split(/\r?\n/).map(line => line.length > 0 ? indent + line : line).join('\n');
    }

    // --- 命令：Narrow (Alt+N) ---
    let narrowCommand = vscode.commands.registerCommand('marmot-narrow-to-region.narrow', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) return;

        const originalDoc = editor.document;
        activeOriginalUri = originalDoc.uri;
        activeRange = new vscode.Range(editor.selection.start, editor.selection.end);
        originalLanguageId = originalDoc.languageId; // 獲取當前語言（如 vue, html, javascript）

        // 1. 處理縮排
        const originalText = originalDoc.getText(activeRange);
        baseIndent = getCommonIndent(originalText);
        const cleanText = removeIndent(originalText, baseIndent);

        // 2. 建立隱藏暫存檔
        const fileName = path.basename(originalDoc.fileName);
        tempFilePath = path.join(path.dirname(originalDoc.fileName), `.narrow.${fileName}`);
        fs.writeFileSync(tempFilePath, cleanText);

        // 3. 開啟 Narrow 視窗並強制設定語言模式
        const tempUri = vscode.Uri.file(tempFilePath);
        const doc = await vscode.workspace.openTextDocument(tempUri);
        
        // 【核心優化】強制將暫存檔設為原檔案的語言模式
        // 這樣如果是 Vue 檔案，暫存檔也會以 Vue 模式開啟
        await vscode.languages.setTextDocumentLanguage(doc, originalLanguageId);
        
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

        // 4. 隱藏原檔案分頁
        await vscode.window.showTextDocument(originalDoc, vscode.ViewColumn.One);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        
        vscode.window.setStatusBarMessage(`Narrow 模式: ${originalLanguageId}`, 3000);
    });

    // --- 命令：Widen (Alt+W) ---
    let widenCommand = vscode.commands.registerCommand('marmot-narrow-to-region.widen', async () => {
        if (tempFilePath && activeOriginalUri) {
            const tempUri = vscode.Uri.file(tempFilePath);
            const tempEditor = vscode.window.visibleTextEditors.find(ed => ed.document.uri.fsPath === tempUri.fsPath);
            
            if (tempEditor) {
                await vscode.window.showTextDocument(tempEditor.document);
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            }

            const originalDoc = await vscode.workspace.openTextDocument(activeOriginalUri);
            const editor = await vscode.window.showTextDocument(originalDoc, vscode.ViewColumn.One);

            if (activeRange) {
                editor.selection = new vscode.Selection(activeRange.start, activeRange.end);
                editor.revealRange(activeRange, vscode.TextEditorRevealType.InCenter);
            }

            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

            tempFilePath = undefined;
            activeOriginalUri = undefined;
            activeRange = undefined;
        }
    });

    // --- 監聽器：同步同步 ---
    const changeListener = vscode.workspace.onDidChangeTextDocument(e => {
        if (tempFilePath && e.document.uri.fsPath === vscode.Uri.file(tempFilePath).fsPath && activeOriginalUri && activeRange) {
            if (syncTimer) clearTimeout(syncTimer);
            syncTimer = setTimeout(async () => {
                isSyncing = true;
                const editedText = e.document.getText();
                const textToRestore = addIndent(editedText, baseIndent);

                const edit = new vscode.WorkspaceEdit();
                edit.replace(activeOriginalUri!, activeRange!, textToRestore);
                
                const success = await vscode.workspace.applyEdit(edit);
                if (success) {
                    const lines = textToRestore.split(/\r?\n/);
                    const lastLineIndex = lines.length - 1;
                    const newEndPos = new vscode.Position(
                        activeRange!.start.line + lastLineIndex,
                        lastLineIndex === 0 ? activeRange!.start.character + lines[lastLineIndex].length : lines[lastLineIndex].length
                    );
                    activeRange = new vscode.Range(activeRange!.start, newEndPos);
                }
                isSyncing = false;
            }, 300);
        }
    });

    context.subscriptions.push(narrowCommand, widenCommand, changeListener);
}