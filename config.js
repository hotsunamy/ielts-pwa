// Cấu hình app. Client ID của Google không phải bí mật, để trong repo public được.
// Dán Client ID lấy từ Google Cloud (bước 1.5 trong hướng dẫn) vào giữa hai dấu nháy.
window.APP_CONFIG = {
  CLIENT_ID: '885455368061-7febjgba6tv4prdj3j3l5sfdueh240p4.apps.googleusercontent.com',
  // drive.readonly: đọc file trong Drive. drive.appdata: vùng dữ liệu ẩn để lưu tiến độ (mốc 6).
  SCOPES: [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.appdata',
  ],
  ROOT_FOLDER_NAME: 'CAMBRIDGE',
};
