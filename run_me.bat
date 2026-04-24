@echo off
TITLE PC App Starter
cd /d C:\pc
echo [1/3] სისტემის შემოწმება...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js არ არის დაინსტალირებული!
    echo გთხოვთ გადმოწეროთ nodejs.org-დან და დააინსტალიროთ.
    pause
    exit
)
echo [2/3] ბიბლიოთეკების განახლება (npm install)...
call npm install
echo [3/3] სერვერის გაშვება...
cls
npm start
pause