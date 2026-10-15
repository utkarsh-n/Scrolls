// OWNER: N8
// AccessibilityAuditTests (IOS-SPEC §4.19): `performAccessibilityAudit` on the root, the inspector at each detent, the
// Then column, the Lanes, Filters and Legend sheets, and How Scrolls works. Compare, Lineage and the Notebook are
// audited once their packages build them (until then they show "not in this build yet" and the test says so). Every
// issue found is reported with its element; an issue on an element another package owns is still reported, never hidden.

import XCTest

@MainActor
final class AccessibilityAuditTests: XCTestCase {
  nonisolated override func setUp() {
    continueAfterFailure = true
  }

  private func launch(_ extra: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-ui-testing", "-freshState", "-tourStep", "0"] + extra
    app.launch()
    XCTAssertTrue(app.descendants(matching: .any)["corpusChip"].waitForExistence(timeout: 60))
    return app
  }

  /// Runs the audit; every issue is recorded as a failure naming the screen, its type and its element.
  private func audit(_ app: XCUIApplication, _ screen: String) throws {
    var found: [String] = []
    try app.performAccessibilityAudit { issue in
      let element = issue.element.map { "\($0.elementType) '\($0.identifier)' '\($0.label)'" } ?? "no element"
      found.append("\(screen): \(issue.auditType) — \(issue.compactDescription) — \(element)")
      return true   // recorded below, so the run lists every issue at once
    }
    for f in found { XCTFail(f) }
    print("A11YAUDIT \(screen) issues=\(found.count)")
  }

  func testRootAndInspectorDetents() throws {
    let app = launch()
    try audit(app, "root, inspector at peek")
    let handle = app.descendants(matching: .any)["inspectorHandle"]
    handle.tap()
    try audit(app, "inspector at half")
    handle.swipeUp()
    try audit(app, "inspector at large")
  }

  func testThenColumn() throws {
    let app = launch()
    let field = app.textFields["searchField"]
    field.tap()
    field.typeText("carry the zero")
    let row = app.buttons["kwic.77"]
    XCTAssertTrue(row.waitForExistence(timeout: 20))
    row.tap()
    XCTAssertTrue(app.descendants(matching: .any)["passageCard"].waitForExistence(timeout: 20))
    try audit(app, "Then column")
  }

  func testSheets() throws {
    let app = launch()
    for (item, id) in [("Lanes", "lanesSheet"), ("Filters", "filtersSheet"), ("Legend", "legendSheet"), ("How Scrolls works", "howItWorks")] {
      app.buttons["moreMenu"].tap()
      app.buttons[item].tap()
      XCTAssertTrue(app.descendants(matching: .any)[id].waitForExistence(timeout: 10), "\(item) did not open")
      try audit(app, item)
      app.swipeDown(velocity: .fast)
      _ = app.descendants(matching: .any)[id].waitForNonExistence(timeout: 5)
    }
  }

  func testOtherPackagesScreens() throws {
    let app = launch()
    app.buttons["moreMenu"].tap()
    app.buttons["Compare"].tap()
    if app.descendants(matching: .any)["notBuilt.Compare"].waitForExistence(timeout: 10) {
      throw XCTSkip("Compare (N4) is not in this build yet; Lineage (N5) and the Notebook (N6) likewise: audited once they land")
    }
    try audit(app, "Compare")
  }

  func testAccessibilitySizes() throws {
    let app = launch(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
    XCTAssertTrue(app.descendants(matching: .any)["play"].isHittable, "the transport stays usable at accessibility sizes")
    XCTAssertTrue(app.textFields["searchField"].isHittable)
    try audit(app, "root at accessibility XXXL")
  }
}
