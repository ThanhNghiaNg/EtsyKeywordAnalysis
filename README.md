# Etsy SEO Analyst

Chrome extension (Manifest V3) quét từng trang tìm kiếm Etsy, lấy listing ID,
gọi API eRank bằng request được ký động, và hiển thị dashboard phân tích SEO.

## Cài đặt

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked** và trỏ tới thư mục `extension`.
4. Đảm bảo bạn đang đăng nhập `https://members.erank.com`.
5. Mở dashboard của extension → **Cấu hình**.
6. Nhập `keyworklist.txt` và `curl.txt`, rồi bấm lưu.
7. Bấm **Chạy phân tích**.

Extension mở từng tab tìm kiếm Etsy ở chế độ nền, cuộn trang để tải listing,
thu thập ID, đóng tab, rồi lấy dữ liệu SEO. Kết quả phân tích được rút gọn và
lưu riêng từng keyword trong IndexedDB. `chrome.storage.local` chỉ giữ cấu hình
và trạng thái tác vụ; curl hay token không được gửi tới nơi nào ngoài eRank.

Mỗi lần tải Etsy hoặc fetch eRank được thử tối đa 3 lần với thời gian chờ tăng
dần. Keyword vẫn lỗi sẽ được đưa xuống cuối queue để thử thêm một lượt; nếu vẫn
lỗi, tác vụ ghi nhận lỗi và tiếp tục keyword khác. Thời gian cache được chỉnh
trong **Cấu hình** (mặc định 10 phút, đặt 0 để tắt). Nút **Ngừng phân tích** ở
dashboard sẽ đóng tab Etsy và hủy fetch đang chạy.

## Khi curl/phiên hết hạn

Dashboard sẽ hiển thị thông báo bắt đầu bằng `CURL_EXPIRED`. Copy curl mới từ
request `https://members.erank.com/ext`, nhập lại trong **Cấu hình**, rồi chạy
tiếp. Các kết quả keyword đã thu thập vẫn được giữ và tác vụ tiếp tục từ keyword
đang bị gián đoạn.

## Chỉ số

- Opportunity score: thang 1–100, kết hợp search/click demand, competition và CTR.
- Exact tag / title match: mức độ đối thủ tối ưu chính xác keyword.
- Listing benchmark: sales, revenue, price ước tính của listings nổi bật.
- Tag opportunities: các tag liên quan được xếp theo nhu cầu so với cạnh tranh.

Opportunity score là chỉ số so sánh tương đối trong bộ keyword, không phải cam
kết doanh số.

## Kiểm tra mã nguồn

Chạy `npm run validate` để kiểm tra Manifest, quyền truy cập, đồng bộ danh sách
keyword, cấu trúc curl và cú pháp JavaScript.
