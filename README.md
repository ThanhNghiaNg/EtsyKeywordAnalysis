# Etsy SEO Analyst

Chrome extension (Manifest V3) quét từng trang tìm kiếm Etsy, lấy listing ID,
gọi API eRank bằng request được ký động, và hiển thị dashboard phân tích SEO.

## Cài đặt

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked** và trỏ tới thư mục `extension`.
4. Đảm bảo bạn đang đăng nhập `https://members.erank.com`.
5. Mở dashboard của extension → **Cấu hình**.
6. Nhập danh sách Keywords rồi bấm `Lưu Keywords`.
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

Dashboard sẽ hiển thị thông báo bắt đầu bằng `CURL_EXPIRED`. Đăng nhập trong `https://members.erank.com`, rồi chạy
tiếp. Các kết quả keyword đã thu thập vẫn được giữ và tác vụ tiếp tục từ keyword
đang bị gián đoạn.

## Chỉ số

- Opportunity score: thang 1–100, kết hợp search/click demand, competition và CTR.
- Exact tag / title match: mức độ đối thủ tối ưu chính xác keyword.
- Listing benchmark: sales, revenue, price ước tính của listings nổi bật.
- Tag opportunities: các tag liên quan được xếp theo nhu cầu so với cạnh tranh.

Top Listings và Tag opportunities có multi-select combobox để gộp một tập
keyword tùy chọn. Khi gộp, listings được chống trùng theo `listing_id` và tag
trùng giữ lại danh sách các keyword nguồn.

Opportunity score là chỉ số so sánh tương đối trong bộ keyword, không phải cam
kết doanh số.

Trong **Cấu hình → Công thức Score bằng JavaScript**, có thể sửa riêng Keyword
Score và Tag Opportunity. Hai editor luôn có sẵn hàm mặc định; nút **Mặc định**
khôi phục hàm mẫu. Danh sách params được khám phá động từ response đã lưu, gồm
cả path lồng nhau, kiểu và giá trị mẫu. Công thức dùng JavaScript chuẩn
(`Math.log10()`, `Math.min()`...), chạy trong sandbox Worker, bị dừng nếu quá
2 giây, và kết quả cuối được giới hạn trong khoảng 1–100.

## Kiểm tra mã nguồn

Chạy `npm run validate` để kiểm tra Manifest, quyền truy cập, đồng bộ danh sách
keyword, cấu trúc curl và cú pháp JavaScript.
