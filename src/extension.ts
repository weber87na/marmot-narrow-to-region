import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
    let activeOriginalUri: vscode.Uri | undefined;
    let activeRange: vscode.Range | undefined;
    let tempFilePath: string | undefined;
    let baseIndent: string = "";

    // --- 工具函數：處理縮排 ---
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
        if (tempFilePath) {
            vscode.window.showWarningMessage('目前已在 Narrow 模式中！');
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) return;

        const originalDoc = editor.document;
        const ext = path.extname(originalDoc.fileName).toLowerCase();

        if (!['.js', '.html'].includes(ext)) {
            vscode.window.showWarningMessage('僅支援 .js 與 .html');
            return;
        }

        activeOriginalUri = originalDoc.uri;
        activeRange = new vscode.Range(editor.selection.start, editor.selection.end);

        // 1. 處理縮排與內容
        const originalText = originalDoc.getText(activeRange);
        baseIndent = getCommonIndent(originalText);
        const cleanText = removeIndent(originalText, baseIndent);

        // 2. 建立隱藏暫存檔
        const fileName = path.basename(originalDoc.fileName);
        tempFilePath = path.join(path.dirname(originalDoc.fileName), `.narrow.${fileName}`);
        fs.writeFileSync(tempFilePath, cleanText);

        // 3. 隱藏父檔案並開啟 Narrow 視窗
        const tempUri = vscode.Uri.file(tempFilePath);
        const doc = await vscode.workspace.openTextDocument(tempUri);

        // 先聚焦父檔並關閉
        await vscode.window.showTextDocument(originalDoc, vscode.ViewColumn.One);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

        // 開啟 Narrow 視窗
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        vscode.window.setStatusBarMessage('Marmot Narrow: 編輯中...', 5000);
    });

    // --- 命令：Widen (Alt+W) 退出並同步 ---
    let widenCommand = vscode.commands.registerCommand('marmot-narrow-to-region.widen', async () => {
        if (tempFilePath && activeOriginalUri && activeRange) {
            const tempUri = vscode.Uri.file(tempFilePath);
            const tempDoc = await vscode.workspace.openTextDocument(tempUri);

            // 1. 取得最終內容並補回縮排
            const editedText = tempDoc.getText();
            const textToRestore = addIndent(editedText, baseIndent);

            // 2. 執行同步回父檔案
            const edit = new vscode.WorkspaceEdit();
            edit.replace(activeOriginalUri, activeRange, textToRestore);
            await vscode.workspace.applyEdit(edit);

            // 3. 關閉 Narrow 視窗 (不存檔)
            const tempEditor = vscode.window.visibleTextEditors.find(ed => ed.document.uri.fsPath === tempUri.fsPath);
            if (tempEditor) {
                await vscode.window.showTextDocument(tempEditor.document);
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            }

            // 4. 重新開啟父檔案並定位
            const originalDoc = await vscode.workspace.openTextDocument(activeOriginalUri);
            const editor = await vscode.window.showTextDocument(originalDoc, vscode.ViewColumn.One);

            // 計算新的結束位置以保持選取區正確
            const lines = textToRestore.split(/\r?\n/);
            const newEndPos = new vscode.Position(
                activeRange.start.line + lines.length - 1,
                lines.length === 1 ? activeRange.start.character + lines[0].length : lines[lines.length - 1].length
            );
            const newRange = new vscode.Range(activeRange.start, newEndPos);

            editor.selection = new vscode.Selection(newRange.start, newRange.end);
            editor.revealRange(newRange, vscode.TextEditorRevealType.InCenter);

            // 5. 清理與解鎖
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            tempFilePath = undefined;
            activeOriginalUri = undefined;
            activeRange = undefined;
            vscode.window.showInformationMessage('已完成同步並退出 Narrow 模式');
        }
    });

    context.subscriptions.push(narrowCommand, widenCommand);
}