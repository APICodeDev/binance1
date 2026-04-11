import Foundation

enum AppFormatters {
    static func price(_ value: Double, precision: Int? = nil) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = precision ?? 2
        formatter.maximumFractionDigits = precision ?? 4
        return formatter.string(from: NSNumber(value: value)) ?? String(format: "%.\(precision ?? 4)f", value)
    }

    static func compact(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 2
        return formatter.string(from: NSNumber(value: value)) ?? String(format: "%.2f", value)
    }

    static func dateTime(_ iso: String?) -> String {
        guard let iso else { return "-" }
        let formatter = ISO8601DateFormatter()
        guard let date = formatter.date(from: iso) else { return iso }
        let output = DateFormatter()
        output.dateStyle = .short
        output.timeStyle = .short
        return output.string(from: date)
    }
}
