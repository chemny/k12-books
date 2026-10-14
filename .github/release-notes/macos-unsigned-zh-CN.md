## 🍎 macOS 安装与运行说明

因为当前 macOS 安装包未购买商业 Apple Developer ID 签名，若系统提示“已损坏”或“无法打开”，请参照以下方法处理：

- 先打开【系统设置】→【隐私与安全性】→【安全性】，查看是否允许“任何来源”；若无此选项，打开终端输入：

  ```bash
  sudo spctl --master-disable
  ```

  回车并输入开机管理员密码。

- 若打开仍报错，在终端执行：

  ```bash
  sudo xattr -r -d com.apple.quarantine /Applications/ChinaK12BookDownLoader.app
  ```

  回车并输入开机管理员密码。

- 若安装在非默认应用程序目录，执行：

  ```bash
  sudo xattr -r -d com.apple.quarantine 
  ```

  （注意最后留一个空格），将应用图标拖入终端回车即可。
