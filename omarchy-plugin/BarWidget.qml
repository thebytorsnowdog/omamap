import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// OmaMap in the Omarchy bar.
//   left click   open OmaMap (or raise the open window)
//   right click  recent profiles and data files; click one to open it
// Reads $XDG_STATE_HOME/omamap/recent.json, which the app keeps up to date.
BarWidget {
  id: root

  moduleName: "thebytorsnowdog.omamap"

  readonly property string homepage: "https://github.com/thebytorsnowdog/omamap"
  readonly property string stateHome: Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")
  readonly property string recentPath: stateHome + "/omamap/recent.json"
  readonly property int maxItems: Math.max(1, Math.min(15, Number(root.setting("maxItems", 8)) || 8))

  property bool installed: true
  property var recent: []
  property bool popupOpen: false

  function close() { popupOpen = false }

  function clean(value, limit) {
    return String(value || "").replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, limit)
  }

  // "/home/me/maps" -> "~/maps", but only for the home directory itself.
  function tidyFolder(dir) {
    var home = Quickshell.env("HOME") || ""
    if (home && (dir === home || dir.indexOf(home + "/") === 0)) return "~" + dir.slice(home.length)
    return dir
  }

  function applyRecent(raw) {
    try {
      if (typeof raw !== "string" || raw.length > 262144) { root.recent = []; return }
      var list = JSON.parse(raw || "{}").recent
      if (!Array.isArray(list)) { root.recent = []; return }
      var out = []
      for (var i = 0; i < list.length && out.length < root.maxItems; i++) {
        var e = list[i]
        // Absolute paths only, and never a path that had to be altered to display.
        if (!e || typeof e.path !== "string" || e.path.charAt(0) !== "/" || /[\x00-\x1f\x7f]/.test(e.path) || e.path.length > 4096) continue
        var path = e.path
        var slash = path.lastIndexOf("/")
        out.push({
          path: path,
          name: root.clean(e.name || path.slice(slash + 1), 120),
          folder: root.clean(root.tidyFolder(path.slice(0, slash)), 4096),
          profile: e.kind === "profile"
        })
      }
      root.recent = out
    } catch (error) {
      root.recent = []
    }
  }

  // Launch with an argument vector, never a shell command line: nothing in a
  // file name (quotes, $(...), backticks, newlines) is interpreted, and "--"
  // stops a name that starts with "-" being read as an option.
  function openOmaMap(path) {
    root.popupOpen = false
    if (!root.installed) { Quickshell.execDetached(["xdg-open", root.homepage]); return }
    Quickshell.execDetached(path ? ["omamap", "--", String(path)] : ["omamap"])
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  FileView {
    path: root.recentPath
    watchChanges: true
    printErrors: false
    onLoaded: root.applyRecent(text())
    onLoadFailed: root.recent = []
    onFileChanged: reload()
  }

  Process {
    id: probe
    command: ["sh", "-c", "command -v omamap >/dev/null"]
    onExited: function(exitCode) { root.installed = exitCode === 0 }
  }

  Component.onCompleted: probe.running = true
  onPopupOpenChanged: if (popupOpen) probe.running = true

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰍍"
    dimmed: !root.installed
    tooltipText: root.installed ? "OmaMap  ·  right-click for recent files" : "OmaMap is not installed  ·  click for instructions"

    onPressed: function(mouseButton) {
      if (mouseButton === Qt.RightButton) root.popupOpen = !root.popupOpen
      else root.openOmaMap("")
    }
  }

  PopupCard {
    id: popup
    anchorItem: root
    bar: root.bar
    owner: root
    open: root.popupOpen
    contentWidth: popup.fittedContentWidth(Style.space(340))
    contentHeight: popup.fittedContentHeight(column.implicitHeight)

    Column {
      id: column
      width: parent.width
      spacing: Style.space(2)

      Text {
        width: parent.width
        textFormat: Text.PlainText
        text: "OMAMAP"
        color: Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        font.letterSpacing: 2
        bottomPadding: Style.space(4)
      }

      Repeater {
        model: [{ path: "", name: root.installed ? "Open OmaMap" : "Install OmaMap…", folder: "", action: true }].concat(root.installed ? root.recent : [])

        delegate: Rectangle {
          id: rowItem
          required property var modelData
          width: column.width
          height: Style.space(modelData.folder ? 40 : 30)
          radius: Style.spacing.labelGap
          color: hover.hovered ? Style.hoverFillFor(Color.foreground, Color.accent, Color.urgent) : "transparent"

          Row {
            anchors.fill: parent
            anchors.leftMargin: Style.space(8)
            anchors.rightMargin: Style.space(8)
            spacing: Style.space(10)

            Text {
              anchors.verticalCenter: parent.verticalCenter
              width: Style.space(16)
              textFormat: Text.PlainText
              text: rowItem.modelData.action ? "󰍍" : (rowItem.modelData.profile ? "󰆼" : "󰈙")
              color: rowItem.modelData.profile || rowItem.modelData.action ? Color.accent : Color.popups.text
              font.family: Style.font.family
              font.pixelSize: Style.font.body
            }

            Column {
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width - Style.space(26)

              Text {
                width: parent.width
                textFormat: Text.PlainText
                elide: Text.ElideMiddle
                text: rowItem.modelData.name
                color: Color.popups.text
                font.family: Style.font.family
                font.pixelSize: Style.font.body
              }
              Text {
                width: parent.width
                visible: rowItem.modelData.folder !== ""
                textFormat: Text.PlainText
                elide: Text.ElideMiddle
                text: rowItem.modelData.folder
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }
            }
          }

          HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
          TapHandler { onTapped: root.openOmaMap(rowItem.modelData.path) }
        }
      }

      Text {
        width: parent.width
        visible: root.installed && root.recent.length === 0
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        text: "No recent files yet. Files you open and profiles you save appear here."
        color: Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        topPadding: Style.space(6)
      }
    }
  }
}
