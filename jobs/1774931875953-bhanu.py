import torch
import torch.nn as nn

# 1. Define a simple model for testing
class SimpleModel(nn.Module):
    def __init__(self):
        super(SimpleModel, self).__init__()
        self.layer = nn.Linear(10, 2)  # Input size 10, Output size 2

    def forward(self, x):
        return self.layer(x)

# 2. Instantiate the model
model = SimpleModel()

# 3. Save the model's state_dict (Recommended method)
# This saves only the learned weights and biases.
torch.save(model.state_dict(), 'test_model.pt')

print("File 'test_model.pt' has been generated successfully.")
