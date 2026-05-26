import os
import sys
import json
import subprocess
import winreg
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

class UnzipTool:
    def __init__(self, root):
        self.root = root
        self.root.title("解压小工具")
        self.root.geometry("360x280")
        self.root.resizable(False, False)

        self.target_ext = tk.StringVar(value=".rar")
        self.password = tk.StringVar(value="")
        self.tool_type = tk.StringVar(value="")
        self.custom_path = tk.StringVar(value="")
        self.selected_items = []

        self.tools = {}
        if getattr(sys, 'frozen', False):
            base_dir = os.path.dirname(sys.executable)
        else:
            base_dir = os.path.dirname(__file__)
        self.config_file = os.path.join(base_dir, "config.json")
        if not os.path.exists(self.config_file):
            self.save_pwd_history({})
        self.pwd_history = self.load_pwd_history()

        self.detect_tools()
        self.create_widgets()

    def load_pwd_history(self):
        try:
            with open(self.config_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                history = data.get("passwords", {})
                sorted_pwds = sorted(history.items(), key=lambda x: x[1], reverse=True)
                return [p[0] for p in sorted_pwds]
        except:
            return []

    def save_pwd_history(self, pwd_counts):
        data = {"passwords": pwd_counts}
        try:
            with open(self.config_file, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except:
            pass

    def add_pwd(self, pwd):
        if not pwd:
            return
        pwd_counts = self._load_pwd_counts()
        pwd_counts[pwd] = pwd_counts.get(pwd, 0) + 1
        self.save_pwd_history(pwd_counts)
        sorted_pwds = sorted(pwd_counts.items(), key=lambda x: x[1], reverse=True)
        self.pwd_history = [p[0] for p in sorted_pwds]
        self.pwd_combo["values"] = self.pwd_history

    def _load_pwd_counts(self):
        try:
            with open(self.config_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data.get("passwords", {})
        except:
            return {}

    def detect_tools(self):
        winrar = self._find_winrar()
        if winrar:
            self.tools["WinRAR"] = winrar
        seven_zip = self._find_7zip()
        if seven_zip:
            self.tools["7-Zip"] = seven_zip
        self.tools["自定义"] = ""

    def _find_winrar(self):
        try:
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WinRAR.exe")
            path, _ = winreg.QueryValueEx(key, "")
            winreg.CloseKey(key)
            if os.path.exists(path):
                return path
        except:
            pass
        try:
            key = winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r"WinRAR\shell\open\command")
            cmd, _ = winreg.QueryValueEx(key, "")
            winreg.CloseKey(key)
            path = cmd.strip('"').split('"')[0]
            if os.path.exists(path):
                return path
        except:
            pass
        paths = [r"C:\Program Files\WinRAR\WinRAR.exe", r"C:\Program Files (x86)\WinRAR\WinRAR.exe"]
        for path in paths:
            if os.path.exists(path):
                return path
        return None

    def _find_7zip(self):
        try:
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\7zFM.exe")
            gui_path, _ = winreg.QueryValueEx(key, "")
            winreg.CloseKey(key)
            exe_path = os.path.join(os.path.dirname(gui_path), "7z.exe")
            if os.path.exists(exe_path):
                return exe_path
        except:
            pass
        try:
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\7-Zip")
            install_dir, _ = winreg.QueryValueEx(key, "Path")
            winreg.CloseKey(key)
            exe_path = os.path.join(install_dir, "7z.exe")
            if os.path.exists(exe_path):
                return exe_path
        except:
            pass
        paths = [r"C:\Program Files\7-Zip\7z.exe", r"C:\Program Files (x86)\7-Zip\7z.exe"]
        for path in paths:
            if os.path.exists(path):
                return path
        return None

    def create_widgets(self):
        # 解压工具 + 目标后缀 合并为一行
        top_frame = ttk.Frame(self.root, padding=(10, 10, 10, 0))
        top_frame.pack(fill=tk.X)

        ttk.Label(top_frame, text="工具:").pack(side=tk.LEFT)
        tool_names = list(self.tools.keys())
        self.tool_type.set(tool_names[0] if tool_names else "自定义")
        self.tool_combo = ttk.Combobox(top_frame, textvariable=self.tool_type,
            values=tool_names, state="readonly", width=10)
        self.tool_combo.pack(side=tk.LEFT, padx=3)
        self.tool_combo.bind("<<ComboboxSelected>>", self.on_tool_changed)

        self.tool_status = ttk.Label(top_frame, text="", foreground="green")
        self.tool_status.pack(side=tk.LEFT, padx=3)

        ttk.Label(top_frame, text="后缀:").pack(side=tk.LEFT, padx=(10, 0))
        ext_combo = ttk.Combobox(top_frame, textvariable=self.target_ext,
            values=[".rar", ".7z", ".zip"], width=7)
        ext_combo.pack(side=tk.LEFT, padx=3)

        # 自定义工具路径行（默认隐藏）
        self.custom_frame = ttk.Frame(self.root, padding=(10, 3, 10, 0))
        ttk.Label(self.custom_frame, text="路径:").pack(side=tk.LEFT)
        self.custom_entry = ttk.Entry(self.custom_frame, textvariable=self.custom_path, width=28)
        self.custom_entry.pack(side=tk.LEFT, padx=3, fill=tk.X, expand=True)
        self.custom_browse = ttk.Button(self.custom_frame, text="浏览", command=self.browse_tool)
        self.custom_browse.pack(side=tk.LEFT)

        self.on_tool_changed()

        # 密码
        pwd_frame = ttk.Frame(self.root, padding=(10, 5, 10, 0))
        pwd_frame.pack(fill=tk.X)
        ttk.Label(pwd_frame, text="密码:").pack(side=tk.LEFT)
        self.pwd_combo = ttk.Combobox(pwd_frame, textvariable=self.password,
            values=self.pwd_history, width=28)
        self.pwd_combo.pack(side=tk.LEFT, padx=3, fill=tk.X, expand=True)

        # 文件选择
        select_frame = ttk.LabelFrame(self.root, text="文件/文件夹", padding=5)
        select_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

        self.select_label = ttk.Label(select_frame, text="将文件拖放到此处，或点击下方按钮", foreground="gray")
        self.select_label.pack(expand=True)

        sel_btn_frame = ttk.Frame(select_frame)
        sel_btn_frame.pack(pady=3)
        ttk.Button(sel_btn_frame, text="选择文件", command=self.select_files).pack(side=tk.LEFT, padx=3)
        ttk.Button(sel_btn_frame, text="选择文件夹", command=self.select_folder).pack(side=tk.LEFT, padx=3)
        ttk.Button(sel_btn_frame, text="清空", command=self.clear_selection).pack(side=tk.LEFT, padx=3)

        # 操作按钮
        action_frame = ttk.Frame(self.root, padding=(10, 3, 10, 5))
        action_frame.pack(fill=tk.X)

        self.unzip_btn = ttk.Button(action_frame, text="开始解压", command=self.start_unzip)
        self.unzip_btn.pack(fill=tk.X)
        self.root.bind("<Return>", lambda e: self.start_unzip())

        self.status_label = ttk.Label(self.root, text="就绪，按 Enter 快速解压", foreground="gray")
        self.status_label.pack(pady=(0, 5))

        # 默认选中上次使用的密码
        if self.pwd_history:
            self.password.set(self.pwd_history[0])
            self.pwd_combo.selection_clear()

    def on_tool_changed(self, event=None):
        tool = self.tool_type.get()

        if tool == "自定义":
            self.tool_status.config(text="")
            self.custom_frame.pack(fill=tk.X)
        else:
            self.custom_frame.pack_forget()
            path = self.tools.get(tool, "")
            if path:
                self.tool_status.config(text="✓", foreground="green")
            else:
                self.tool_status.config(text="未找到", foreground="red")

    def browse_tool(self):
        path = filedialog.askopenfilename(
            title="选择解压工具",
            filetypes=[("可执行文件", "*.exe"), ("WinRAR", "WinRAR.exe"), ("7-Zip", "7z.exe"), ("所有文件", "*.*")]
        )
        if path:
            self.custom_path.set(path)

    def get_tool_path(self):
        tool = self.tool_type.get()
        if tool == "自定义":
            path = self.custom_path.get().strip()
        else:
            path = self.tools.get(tool, "")
        return path if path and os.path.exists(path) else None

    def is_7zip_tool(self):
        tool = self.tool_type.get()
        path = self.get_tool_path()
        if tool == "7-Zip":
            return True
        if path:
            basename = os.path.basename(path).lower()
            if basename in ("7z.exe", "7za.exe"):
                return True
        return False

    def select_files(self):
        files = filedialog.askopenfilenames(title="选择文件")
        if files:
            self.selected_items = list(files)
            self.select_label.config(text=f"已选择 {len(files)} 个文件", foreground="black")

    def select_folder(self):
        folder = filedialog.askdirectory(title="选择文件夹")
        if folder:
            self.selected_items = [folder]
            self.select_label.config(text=f"已选择: {os.path.basename(folder)} 文件夹", foreground="black")

    def clear_selection(self):
        self.selected_items = []
        self.select_label.config(text="将文件拖放到此处，或点击下方按钮", foreground="gray")

    def get_all_files(self, path):
        files = []
        if os.path.isdir(path):
            for item in os.listdir(path):
                full_path = os.path.join(path, item)
                if os.path.isfile(full_path):
                    files.append(full_path)
        elif os.path.isfile(path):
            files.append(path)
        return files

    def start_unzip(self):
        exe_path = self.get_tool_path()
        if not exe_path:
            messagebox.showerror("错误", "解压工具未找到，请先选择有效的工具路径")
            return

        if not self.selected_items:
            messagebox.showwarning("提示", "请先选择文件或文件夹")
            return

        target_ext = self.target_ext.get()
        pwd = self.password.get()
        is_7z = self.is_7zip_tool()
        total = 0
        success = 0

        for item in self.selected_items:
            files = self.get_all_files(item)
            for file_path in files:
                total += 1
                self.status_label.config(text=f"处理中: {os.path.basename(file_path)}", foreground="blue")
                self.root.update()

                new_path = file_path
                if not file_path.lower().endswith(target_ext.lower()):
                    base, _ = os.path.splitext(file_path)
                    new_path = base + target_ext
                    os.rename(file_path, new_path)

                try:
                    output_dir = os.path.dirname(new_path)
                    if is_7z:
                        cmd = [exe_path, "x", "-y", new_path, f"-o{output_dir}"]
                    else:
                        cmd = [exe_path, "x", "-y", new_path, f"{output_dir}\\"]

                    if pwd:
                        cmd.insert(2, f"-p{pwd}")

                    subprocess.run(cmd, check=True, capture_output=True, encoding="gbk")
                    success += 1
                except Exception:
                    if pwd:
                        cmd_without_pwd = [c for c in cmd if not c.startswith("-p")]
                        try:
                            subprocess.run(cmd_without_pwd, check=True, capture_output=True, encoding="gbk")
                            success += 1
                        except Exception as e2:
                            self.status_label.config(text=f"失败: {str(e2)}", foreground="red")
                    else:
                        self.status_label.config(text=f"失败", foreground="red")

        if success > 0 and pwd:
            self.add_pwd(pwd)

        self.status_label.config(text=f"完成! 成功: {success}/{total}", foreground="green")
        messagebox.showinfo("完成", f"解压完成!\n成功: {success}\n失败: {total - success}")
        self.selected_items = []
        self.select_label.config(text="将文件拖放到此处，或点击下方按钮", foreground="gray")

if __name__ == "__main__":
    root = tk.Tk()
    app = UnzipTool(root)
    root.mainloop()